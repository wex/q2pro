import { MvdDemoReader } from '../src/demo';
import { MvdFrameParser, FrameEvent, ServerDataEvent, ConfigStringEvent, ChatEvent, ObituaryEvent, DeathEvent, SoundEvent, classifyHit, classifyChat, classifyObituary } from '../src/frame';
import { readDemoBytes } from './helpers/fixtures';
import { StatsTracker } from '../src/stats';

interface ParseResult {
    serverData: ServerDataEvent[];
    configstrings: Map<number, string>;
    frames: FrameEvent[];
    chats: ChatEvent[];
    obits: ObituaryEvent[];
    deaths: DeathEvent[];
    sounds: SoundEvent[];
    parseErrors: unknown[];
    parseWarnings: number;
}

function parseDemo(): ParseResult {
    const result: ParseResult = {
        serverData: [],
        configstrings: new Map(),
        frames: [],
        chats: [],
        obits: [],
        deaths: [],
        sounds: [],
        parseErrors: [],
        parseWarnings: 0,
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
    parser.onDeath = (ev) => result.deaths.push({ ...ev, origin: [...ev.origin] as [number, number, number] });
    parser.onSound = (ev) => result.sounds.push({ ...ev, position: ev.position ? [...ev.position] as [number, number, number] : undefined });
    parser.onParseWarning = () => result.parseWarnings++;

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

    test('emits onDeath with finite world-space origin when STAT_HEALTH drops to <=0', () => {
        // The bundled demo contains player deaths, so we expect at least one.
        expect(result.deaths.length).toBeGreaterThan(0);
        for (const d of result.deaths) {
            expect(Number.isInteger(d.clientNum)).toBe(true);
            expect(d.clientNum).toBeGreaterThanOrEqual(0);
            expect(d.origin).toHaveLength(3);
            for (const n of d.origin) expect(Number.isFinite(n)).toBe(true);
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
            // weaponTypeNum is optional (AQ2 VWEP); when present must be a finite int.
            if (p.weaponTypeNum !== undefined) {
                expect(Number.isInteger(p.weaponTypeNum)).toBe(true);
                expect(p.weaponTypeNum).toBeGreaterThan(0);
            }
        }
    });

    test('no parse warnings on the bundled demo (inner svc ops are walked)', () => {
        // demo.mvd2 contains svc_sound inside multicast payloads; every inner
        // op must be consumable without tripping the unknown-op bail-out.
        expect(result.parseWarnings).toBe(0);
    });

    test('obituaries classify into kill/world/info with AQ2 attribution', () => {
        // The demo's confirmed MK23 headshot kill must attribute correctly.
        expect(result.obits).toContainEqual(expect.objectContaining({
            kind: 'kill', victim: 'fren waters', attacker: 'mJw - Royce',
            mod: 'mk23', weapon: 'mk23', location: 'head',
        }));
        // "... plummets to his death" is a world death, not a kill.
        expect(result.obits).toContainEqual(expect.objectContaining({
            kind: 'world', attacker: null, mod: 'falling',
        }));
        // Bot-nav PRINT_MEDIUM lines are info, not obituaries.
        expect(result.obits).toContainEqual(expect.objectContaining({ kind: 'info', victim: '' }));
        for (const o of result.obits) {
            if (o.kind === 'kill') {
                expect(o.attacker).not.toBeNull();
                expect(o.victim.length).toBeGreaterThan(0);
            }
        }
    });

    test('StatsTracker attributes the demo kill end-to-end', () => {
        const tracker = new StatsTracker();
        for (const o of result.obits) tracker.noteObituary(o);
        for (const d of result.deaths) tracker.noteDeath(d);
        const snap = tracker.snapshot();
        expect(snap.totals.players['mJw - Royce'].kills).toBe(1);
        expect(snap.totals.weaponKills).toEqual({ mk23: 1 });
        // No info-line garbage players leaked into the stats.
        for (const name of Object.keys(snap.totals.players)) {
            expect(name.length).toBeGreaterThan(0);
        }
    });

    test('emits onSound for the demo\'s inner svc_sound packets', () => {
        // The demo carries svc_sound in multicasts (previously dropped as
        // unknown-op warnings). Every event must decode with sane defaults.
        expect(result.sounds.length).toBeGreaterThan(0);
        for (const s of result.sounds) {
            expect(Number.isInteger(s.index)).toBe(true);
            expect(s.index).toBeGreaterThanOrEqual(0);
            expect(s.volume).toBeGreaterThanOrEqual(0);
            expect(s.volume).toBeLessThanOrEqual(1);
            // 0 is legitimate — ATTN_NONE means "no attenuation" (global sound).
            expect(s.attenuation).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(s.entity)).toBe(true);
            expect(s.channel).toBeGreaterThanOrEqual(0);
            expect(s.channel).toBeLessThanOrEqual(7);
        }
    });

    test('isMvdDummy is set only on the serverdata.clientNum slot', () => {
        // The demo's serverdata advertises a clientNum; the parser must flag
        // exactly that slot across every frame (or none, when clientNum=-1).
        const sd = result.serverData[0];
        for (const f of result.frames) {
            for (const p of f.players) {
                if (sd.clientNum === -1) {
                    expect(p.isMvdDummy).toBe(false);
                } else {
                    expect(p.isMvdDummy).toBe(p.number === sd.clientNum);
                }
            }
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

    test('classifyObituary matches vanilla Q2 templates', () => {
        expect(classifyObituary('Alice killed himself\n')).toEqual({
            victim: 'Alice', attacker: null, weapon: 'suicide', raw: 'Alice killed himself',
            kind: 'suicide', mod: 'suicide', location: null,
        });
        expect(classifyObituary('Bob was blasted by Charlie\n')).toEqual({
            victim: 'Bob', attacker: 'Charlie', weapon: 'blaster', raw: 'Bob was blasted by Charlie',
            kind: 'kill', mod: 'blaster', location: 'body',
        });
    });

    test('classifyObituary matches AQ2 templates via the ported table', () => {
        // The canonical AQ2/TNG line — previously fell into raw-only.
        const raw = "Alice has a hole in his head from Bob's Mark 23 pistol";
        expect(classifyObituary(raw + '\n')).toEqual({
            victim: 'Alice', attacker: 'Bob', weapon: 'mk23', raw,
            kind: 'kill', mod: 'mk23', location: 'head',
        });

        const raw2 = 'Alice ate too much glass';
        expect(classifyObituary(raw2 + '\n')).toEqual({
            victim: 'Alice', attacker: null, weapon: 'glass', raw: raw2,
            kind: 'world', mod: 'glass', location: null,
        });
    });

    test('classifyObituary marks non-death PRINT_MEDIUM lines as info', () => {
        const raw = 'Saving node table...';
        expect(classifyObituary(raw + '\n')).toEqual({
            victim: '', attacker: null, weapon: null, raw,
            kind: 'info', mod: null, location: null,
        });
    });

    test('classifyChat strips non-ASCII and high-bit bytes', () => {
        // BEL (0x07) ding + high-bit coloured characters.
        expect(classifyChat('nick\x07: hi\xB0there\n')).toEqual({
            name: 'nick', text: 'hithere', raw: 'nick: hithere',
        });
        // System line (no "name: " prefix) with control bytes stripped.
        expect(classifyChat('\x01server restart\x00\n')).toEqual({
            name: '', text: 'server restart', raw: 'server restart',
        });
        // Pure ASCII chat passes through untouched.
        expect(classifyChat('Alice: hello world\n')).toEqual({
            name: 'Alice', text: 'hello world', raw: 'Alice: hello world',
        });
        // DEL (0x7F) and 0x80 are outside printable ASCII 0x20-0x7E.
        expect(classifyChat('n\x7Fx: a\x80b\n')).toEqual({
            name: 'nx', text: 'ab', raw: 'nx: ab',
        });
    });

    test('unknown MVD opcode fires onParseWarning and counts dropped bytes', () => {
        const parser = new MvdFrameParser();
        const warnings: Array<{ code: string; opcode: number; droppedBytes?: number }> = [];
        parser.onParseWarning = (w) => warnings.push(w);
        // Opcode byte 0x7F → low SVCMD_MASK bits are the op (0x1F = 31), unknown.
        parser.parse(Buffer.from([0x7f, 0xaa, 0xbb, 0xcc]));
        expect(parser.parseWarningCount).toBe(1);
        expect(parser.droppedBytes).toBe(3);
        expect(warnings).toEqual([
            { code: 'unknown_mvd_op', opcode: 0x1f, offset: 1, droppedBytes: 3 },
        ]);
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

// ── Inner svc ops inside unicast/multicast payloads ────────────────

function u16(v: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; }
function i16(v: number): Buffer { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; }
function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; }

/** Wrap inner svc bytes in an mvd_multicast_all op (extrabits=0, no leafnum). */
function mcastAll(payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([0x0a, payload.length]), payload]);
}

// svc_temp_entity TE_BLOOD at raw pos [8,16,24] (→ world [1,2,3]), dir 0.
const TE_BLOOD_VANILLA = Buffer.from([3, 1, 8, 0, 16, 0, 24, 0, 0]);
// Same TE with ext2 delta-encoded coords (v = pos << 1, low bit clear).
const TE_BLOOD_EXT2 = Buffer.from([3, 1, 16, 0, 32, 0, 48, 0, 0]);

/**
 * Minimal mvd_serverdata followed by an empty baseline frame.
 * `flags` travel in the opcode extrabits for version < 2012, as a u16 word
 * after `version` for >= 2012.
 */
function serverdataMsg(flags: number, version: number): Buffer {
    const head = version >= 2012
        ? Buffer.concat([Buffer.from([4]), u32(37), u16(version), u16(flags)])
        : Buffer.concat([Buffer.from([4 | (flags << 5)]), u32(37), u16(version)]);
    return Buffer.concat([
        head,
        u32(1),                 // servercount
        Buffer.from('action\0'), // gamedir
        i16(-1),                // clientNum (SinglePov: no dummy)
        u16(0xffff),            // configstring terminator (>= csEnd)
        Buffer.from([0, 0xff, 0, 0]), // empty baseline frame
    ]);
}

describe('inner svc ops', () => {
    function expectBlood(parser: MvdFrameParser): Array<{ type: number; position?: number[] }> {
        const tes: Array<{ type: number; position?: number[] }> = [];
        parser.onTempEntity = (ev) => tes.push({ type: ev.type, position: ev.position });
        return tes;
    }

    function collectSounds(parser: MvdFrameParser): SoundEvent[] {
        const sounds: SoundEvent[] = [];
        parser.onSound = (ev) => sounds.push(ev);
        return sounds;
    }

    test('svc_sound (flags 0) is skipped, following svc_temp_entity still parsed', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        parser.parse(mcastAll(Buffer.concat([Buffer.from([9, 0, 7]), TE_BLOOD_VANILLA])));
        expect(parser.parseWarningCount).toBe(0);
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
        // No flags → all defaults: full volume, ATTN_NORM, world entity.
        expect(sounds).toEqual([{
            flags: 0, index: 7, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 0, channel: 0, position: undefined,
        }]);
    });

    test('svc_sound with SND_ENT and SND_POS consumes the right byte count', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        // flags = ENT(8)|POS(4) → u8 index, u16 sendchan, 3x int16 pos.
        const sound = Buffer.from([9, 12, 5, 0x10, 0x00, 64, 0, 128, 0, 192, 0]);
        parser.parse(mcastAll(Buffer.concat([sound, TE_BLOOD_VANILLA])));
        expect(parser.parseWarningCount).toBe(0);
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
        // sendchan 0x10 = entity 2, channel 0; pos [64,128,192] → world [8,16,24].
        expect(sounds).toEqual([{
            flags: 12, index: 5, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 2, channel: 0, position: [8, 16, 24],
        }]);
    });

    test('svc_sound with SND_VOLUME/ATTENUATION/OFFSET optional bytes', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        // flags = VOL(1)|ATT(2)|OFS(16) → u8 index, then 3 optional u8s.
        const sound = Buffer.from([9, 19, 5, 255, 64, 20]);
        parser.parse(mcastAll(Buffer.concat([sound, TE_BLOOD_VANILLA])));
        expect(parser.parseWarningCount).toBe(0);
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
        expect(sounds).toEqual([{
            flags: 19, index: 5, volume: 1, attenuation: 1, timeOffset: 0.02,
            entity: 0, channel: 0, position: undefined,
        }]);
    });

    test('svc_sound SND_INDEX16 reads a u16 index on extended streams', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        let ext = false;
        parser.onServerData = (ev) => { ext = ev.extended; };
        parser.parse(serverdataMsg(4, 2011)); // MVF_EXTLIMITS
        expect(ext).toBe(true);
        // flags = INDEX16(32)|ENT(8) → u16 index, u16 sendchan.
        const sound = Buffer.from([9, 40, 0x34, 0x12, 0x10, 0x00]);
        parser.parse(mcastAll(Buffer.concat([sound, TE_BLOOD_VANILLA])));
        expect(parser.parseWarningCount).toBe(0);
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
        // 0x1234 index; sendchan 0x10 → entity 2, channel 0.
        expect(sounds).toEqual([{
            flags: 40, index: 0x1234, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 2, channel: 0, position: undefined,
        }]);
    });

    test('svc_sound SND_POS uses ext2 coords on extensions2 streams', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        // MVF_EXTLIMITS(4)|MVF_EXTLIMITS_2(8) = 12, version 2012 → u16 flags word.
        parser.parse(serverdataMsg(12, 2012));
        // flags = INDEX16(32)|ENT(8)|POS(4): u16 index, u16 chan, 3x ext2 coord.
        const sound = Buffer.from([9, 44, 0x34, 0x12, 0x10, 0x00, 16, 0, 32, 0, 48, 0]);
        parser.parse(mcastAll(Buffer.concat([sound, TE_BLOOD_EXT2])));
        expect(parser.parseWarningCount).toBe(0);
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
        expect(sounds).toEqual([{
            flags: 44, index: 0x1234, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 2, channel: 0, position: [1, 2, 3],
        }]);
    });

    test('truncated svc_sound stops the walk without crashing', () => {
        const parser = new MvdFrameParser();
        const tes = expectBlood(parser);
        const sounds = collectSounds(parser);
        // flags = ENT|POS but the payload ends early → remaining svc ops lost.
        parser.parse(mcastAll(Buffer.from([9, 12, 5])));
        expect(tes).toEqual([]);
        expect(sounds).toEqual([]);
        // Parser still usable on the next message.
        parser.parse(mcastAll(TE_BLOOD_VANILLA));
        expect(tes).toEqual([{ type: 1, position: [1, 2, 3] }]);
    });

    test('per-recipient svc_centerprint duplicates dedupe within a tick', () => {
        const parser = new MvdFrameParser();
        const cps: Array<{ clientNum: number; text: string }> = [];
        parser.onCenterPrint = (ev) => cps.push(ev);
        const cp = (t: string) => Buffer.concat([Buffer.from([15]), Buffer.from(t + '\0')]);
        const uni = (n: number, p: Buffer) => Buffer.concat([Buffer.from([8, p.length, n]), p]);
        // CenterPrintAll → one mvd_unicast per recipient in the same tick.
        parser.parse(Buffer.concat([uni(0, cp('LIGHTS...')), uni(1, cp('LIGHTS...')), uni(18, cp('LIGHTS...'))]));
        // A different text in the same tick is not swallowed.
        parser.parse(uni(0, cp('CAMERA...')));
        expect(cps).toEqual([
            { clientNum: 0, text: 'LIGHTS...' },
            { clientNum: 0, text: 'CAMERA...' },
        ]);
        // mvd_frame boundary resets the window.
        parser.parse(Buffer.from([6, 0, 0xff, 0, 0]));
        parser.parse(uni(2, cp('LIGHTS...')));
        expect(cps).toHaveLength(3);
    });

    test('inner svc_configstring inside unicast fires onConfigString', () => {
        const parser = new MvdFrameParser();
        const events: Array<{ index: number; value: string }> = [];
        parser.onConfigString = (ev) => events.push(ev);
        // mvd_unicast (8): len u8, clientNum u8, payload.
        const inner = Buffer.concat([Buffer.from([13]), u16(1312), Buffer.from('x\0')]);
        const msg = Buffer.concat([Buffer.from([8, inner.length, 0]), inner]);
        parser.parse(msg);
        expect(events).toEqual([{ index: 1312, value: 'x' }]);
    });

    test('outer mvd_sound emits onSound with entity/channel, never a position', () => {
        const parser = new MvdFrameParser();
        const sounds: SoundEvent[] = [];
        parser.onSound = (ev) => sounds.push(ev);
        // op 16, flags = ENT(8): u8 index, u16 sendchan — unconditional even
        // without SND_ENT (MVD_ParseSound line 452). 0x2B = entity 5, chan 3.
        parser.parse(Buffer.from([16, 8, 3, 0x2b, 0x00]));
        expect(sounds).toEqual([{
            flags: 8, index: 3, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 5, channel: 3, position: undefined,
        }]);
    });

    test('outer mvd_sound with flags 0 still reads the sendchan word', () => {
        const parser = new MvdFrameParser();
        const sounds: SoundEvent[] = [];
        parser.onSound = (ev) => sounds.push(ev);
        // flags 0: index u8, then mandatory u16 sendchan. 0x0202 → ent 64, chan 2.
        parser.parse(Buffer.from([16, 0, 9, 0x02, 0x02]));
        expect(sounds).toEqual([{
            flags: 0, index: 9, volume: 1, attenuation: 1, timeOffset: 0,
            entity: 64, channel: 2, position: undefined,
        }]);
    });
});
