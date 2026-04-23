import { MvdDemoReader } from '../src/demo';
import { MvdFrameParser, FrameEvent, ServerDataEvent, ConfigStringEvent, ChatEvent, ObituaryEvent, classifyHit } from '../src/frame';
import { readDemoBytes } from './helpers/fixtures';

interface ParseResult {
    serverData: ServerDataEvent[];
    configstrings: Map<number, string>;
    frames: FrameEvent[];
    chats: ChatEvent[];
    obits: ObituaryEvent[];
    parseErrors: unknown[];
}

function parseDemo(): ParseResult {
    const result: ParseResult = {
        serverData: [],
        configstrings: new Map(),
        frames: [],
        chats: [],
        obits: [],
        parseErrors: [],
    };

    const parser = new MvdFrameParser();
    parser.onServerData = (ev) => {
        result.serverData.push(ev);
        // ServerData carries an initial configstring bundle — persist it here
        // since `onConfigString` only fires for subsequent in-stream deltas.
        for (const [idx, val] of ev.configstrings) result.configstrings.set(idx, val);
    };
    parser.onConfigString = (ev: ConfigStringEvent) => result.configstrings.set(ev.index, ev.value);
    parser.onFrame = (ev) => result.frames.push({
        ...ev,
        // Freeze a shallow copy so later mutations (if any) don't leak into assertions.
        players: ev.players.map((p) => ({ ...p, origin: [...p.origin] as [number, number, number] })),
    });
    parser.onChat = (ev) => result.chats.push(ev);
    parser.onObituary = (ev) => result.obits.push(ev);

    const reader = new MvdDemoReader({ realtime: false });
    // Bypass the async drain path and feed messages synchronously into the parser.
    reader.on('message', (buf) => {
        try {
            parser.parse(buf);
        } catch (err) {
            result.parseErrors.push(err);
            parser.reset();
        }
    });

    // Decode synchronously via a private entry point: call playBuffer but
    // force a synchronous drain by turning off realtime.
    reader.playBuffer(readDemoBytes());
    // drainAll is scheduled in a microtask; wait for it in the caller.
    return result;
}

describe('MvdFrameParser against demo.mvd2', () => {
    let result: ParseResult;

    beforeAll(async () => {
        result = parseDemo();
        // playBuffer queues a microtask that runs drainAll; let it fire.
        await new Promise((r) => setImmediate(r));
    });

    test('did not throw; at least one serverdata observed', () => {
        expect(result.parseErrors).toHaveLength(0);
        expect(result.serverData.length).toBeGreaterThan(0);
        const sd = result.serverData[0];
        expect(typeof sd.gamedir).toBe('string');
        expect(sd.gamedir.length).toBeGreaterThan(0);
    });

    test('configstrings include at least one maps/<name>.bsp entry', () => {
        expect(result.configstrings.size).toBeGreaterThan(0);
        const mapStr = Array.from(result.configstrings.values())
            .find((v) => /^maps\/.+\.bsp$/.test(v));
        expect(mapStr).toBeDefined();
    });

    test('frameNumber is a non-negative integer on every frame', () => {
        expect(result.frames.length).toBeGreaterThan(0);
        // A single demo may contain multiple serverdata sections that reset
        // numbering, so we don't assume global monotonicity — just that every
        // value is a well-formed non-negative integer.
        for (const f of result.frames) {
            expect(Number.isInteger(f.frameNumber)).toBe(true);
            expect(f.frameNumber).toBeGreaterThanOrEqual(0);
        }
    });

    test('at least one frame has active players with finite origins/viewangles', () => {
        const frameWithPlayers = result.frames.find((f) => f.players.length > 0);
        expect(frameWithPlayers).toBeDefined();
        for (const p of frameWithPlayers!.players) {
            expect(p.origin).toHaveLength(3);
            expect(p.viewangles).toHaveLength(3);
            for (const n of p.origin) expect(Number.isFinite(n)).toBe(true);
            for (const n of p.viewangles) expect(Number.isFinite(n)).toBe(true);
        }
    });
});

describe('MvdFrameParser misc', () => {
    test('originToWorld scales by 1/8', () => {
        expect(MvdFrameParser.originToWorld([8, 16, -8])).toEqual([1, 2, -1]);
    });

    test('classifyHit recognizes AQ2 location hit prints', () => {
        expect(classifyHit('You hit Alice in the head\n'))
            .toEqual({ victim: 'Alice', location: 'head', raw: 'You hit Alice in the head' });
        expect(classifyHit('You hit Bob in the legs\n'))
            .toEqual({ victim: 'Bob', location: 'legs', raw: 'You hit Bob in the legs' });
        expect(classifyHit('You hit your TEAMMATE Charlie!\n'))
            .toEqual({ victim: 'Charlie', location: 'body', raw: 'You hit your TEAMMATE Charlie!' });
    });

    test('classifyHit recognizes kevlar-helmet absorbed hits', () => {
        // Sniper AP round into a helmet (still bleeds, still a hit).
        expect(classifyHit('Alice has a Kevlar Helmet, too bad you have AP rounds...\n'))
            .toEqual({
                victim: 'Alice',
                location: 'head',
                raw: 'Alice has a Kevlar Helmet, too bad you have AP rounds...',
            });
        // Non-AP bullet into a helmet.
        expect(classifyHit('Bob has a Kevlar Helmet - AIM FOR THE BODY!\n'))
            .toEqual({
                victim: 'Bob',
                location: 'head',
                raw: 'Bob has a Kevlar Helmet - AIM FOR THE BODY!',
            });
    });

    test('classifyHit returns null on unrelated prints', () => {
        expect(classifyHit('Head damage\n')).toBeNull();
        expect(classifyHit('You were hit by Alice, your TEAMMATE!\n')).toBeNull();
        expect(classifyHit('')).toBeNull();
    });

    test('malformed input throws, reset() restores a usable parser', () => {
        const parser = new MvdFrameParser();
        let frames = 0;
        parser.onFrame = () => frames++;

        // MvdOp.ServerData (4) immediately followed by a single byte — the
        // readInt32LE in parseServerData will read past end and throw.
        const truncated = Buffer.from([0x04, 0x00]);
        expect(() => parser.parse(truncated)).toThrow();

        parser.reset();
        // After reset the parser should be re-usable: feed the real demo and
        // confirm at least one frame arrives.
        const reader = new MvdDemoReader({ realtime: false });
        reader.on('message', (buf) => {
            try { parser.parse(buf); } catch { parser.reset(); }
        });
        reader.playBuffer(readDemoBytes());
        return new Promise<void>((resolve) => setImmediate(() => {
            expect(frames).toBeGreaterThan(0);
            resolve();
        }));
    });
});
