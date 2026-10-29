import { Session } from '../src/session';
import { ClientState } from '../src/protocol';
import { DEMO_PATH } from './helpers/fixtures';

function make() {
    return new Session('t', {
        host: '127.0.0.1',
        port: 27910,
        broadcast: () => {},
        statusQuery: () => {},
        clientOpts: { autoReconnect: false },
    });
}

describe('Session.dispose', () => {
    test('dispose on an idle session does not throw', () => {
        const s = make();
        expect(() => s.dispose()).not.toThrow();
        expect(s.client.state).toBe(ClientState.Disconnected);
    });

    test('dispose stops an active replay and clears all timers/fds', () => {
        const s = make();
        s.startReplay(DEMO_PATH);
        expect(s.currentReplay).not.toBeNull();

        s.dispose();
        expect(s.currentReplay).toBeNull();
        expect(s.currentReplayFile).toBeNull();
        expect(s.recorder.recording).toBe(false);
        expect(s.client.state).toBe(ClientState.Disconnected);
        expect(s.client.reconnectPending).toBe(false);
    });
});

describe('MVD dummy slot', () => {
    test('serverdata clientNum is exposed as dummyNum and in the snapshot', () => {
        const s = make();
        expect(s.dummyNum).toBe(-1);
        s.parser.onServerData?.({
            protocol: 38,
            version: 2007,
            flags: 0,
            extended: false,
            servercount: 1,
            gamedir: 'action',
            clientNum: 7,
            configstrings: new Map(),
        });
        expect(s.dummyNum).toBe(7);
        expect(s.snapshot().clientNum).toBe(7);
        s.dispose();
    });
});

describe('replay start', () => {
    test('startReplay broadcasts an initial replayState with real messageCount', () => {
        const events: { e: string; d: any }[] = [];
        const s = new Session('t', {
            host: '127.0.0.1',
            port: 27910,
            broadcast: (e, d) => events.push({ e, d: d as any }),
            statusQuery: () => {},
            clientOpts: { autoReconnect: false },
        });
        s.startReplay(DEMO_PATH);
        // The UI needs messageCount immediately — without an initial
        // broadcast the scrubber stayed at the previous replay's position.
        const rs = events.find((x) => x.e === 'replayState');
        expect(rs).toBeDefined();
        expect(rs!.d.position).toBe(0);
        expect(rs!.d.messageCount).toBeGreaterThan(0);
        s.dispose();
    });
});

describe('replay seek catch-up', () => {
    test('catch-up messages rebuild state silently — only seeked broadcasts', () => {
        const events: string[] = [];
        const s = new Session('t', {
            host: '127.0.0.1',
            port: 27910,
            broadcast: (e) => events.push(e),
            statusQuery: () => {},
            clientOpts: { autoReconnect: false },
        });
        s.startReplay(DEMO_PATH);
        events.length = 0;

        // Seek lands mid-demo: [keyframe, target) parses silently (no
        // serverdata/frame/kill SSE storm), then one replayState broadcast.
        s.currentReplay!.seek(100);
        expect(events).toEqual(['replayState']);
        s.dispose();
    });
});

describe('entity-attached sound pings', () => {
    const frameWithPlayer = (num: number, origin: [number, number, number]) => ({
        frameNumber: 1,
        players: [{
            number: num, inUse: true, pmType: 0, origin,
            viewangles: [0, 0, 0] as [number, number, number],
            viewoffset: [0, 0, 0] as [number, number, number],
            fov: 90, gunindex: 0, rdflags: 0, frags: 0,
            stats: new Int16Array(32), isMvdDummy: false,
        }],
        teamScores: { team1: 0, team2: 0, team3: 0 },
        layoutsFlags: 0,
    });
    const snd = (entity: number, position?: [number, number, number]) => ({
        flags: 0, index: 1, volume: 1, attenuation: 1, timeOffset: 0,
        entity, channel: 3, position,
    });

    test('SND_ENT-only sounds resolve the emitting player origin', () => {
        const events: { e: string; d: any }[] = [];
        const s = new Session('t', {
            host: '127.0.0.1', port: 27910,
            broadcast: (e, d) => events.push({ e, d: d as any }),
            statusQuery: () => {},
            clientOpts: { autoReconnect: false },
        });
        s.parser.onFrame?.(frameWithPlayer(3, [100, 200, 0]));

        // Footstep-style event: outer mvd_sound, entity 4 = clientNum 3.
        s.parser.onSound?.(snd(4));
        const sounds = () => events.filter((x) => x.e === 'sound');
        expect(sounds()[0].d.position).toEqual([100, 200, 0]);
        expect(sounds()[0].d.posDerived).toBe(true);

        // Wire-provided positions win over derivation.
        s.parser.onSound?.(snd(4, [9, 9, 9]));
        expect(sounds()[1].d.position).toEqual([9, 9, 9]);
        expect(sounds()[1].d.posDerived).toBeUndefined();

        // Non-player edicts resolve nothing → position stays undefined.
        s.parser.onSound?.(snd(60));
        expect(sounds()[2].d.position).toBeUndefined();
        s.dispose();
    });
});

describe('TE_DAMAGE_DEALT damage stats', () => {
    test('unicast damage-dealt TEs accumulate on the recipient player', () => {
        const s = make();
        // mvd_unicast (8): len u8, clientNum u8, inner svc payload =
        // svc_temp_entity (3) + TE_DAMAGE_DEALT (128) + damage i16.
        const dd = (n: number, dmg: number) => {
            const inner = Buffer.alloc(4);
            inner[0] = 3; inner[1] = 128;
            inner.writeInt16LE(dmg, 2);
            return Buffer.concat([Buffer.from([8, inner.length, n]), inner]);
        };
        s.parser.parse(dd(5, 37));
        s.parser.parse(dd(5, 23));
        s.parser.parse(dd(2, 80));
        // Multicast TEs have no recipient → ignored by damage stats.
        const mc = Buffer.alloc(4);
        mc[0] = 3; mc[1] = 128; mc.writeInt16LE(9, 2);
        s.parser.parse(Buffer.concat([Buffer.from([0x0a, mc.length]), mc]));

        const players = s.stats.snapshot().totals.players;
        expect(players['5'].damageDealt).toBe(60);
        expect(players['2'].damageDealt).toBe(80);
        expect(Object.keys(players)).toHaveLength(2);
        s.dispose();
    });
});

describe('round team scores', () => {
    test('onFrame feeds teamScores; end marker stamps the round', () => {
        const s = make();
        const frame = (t1: number, t2: number, t3: number) => s.parser.onFrame?.({
            frameNumber: 0,
            players: [],
            teamScores: { team1: t1, team2: t2, team3: t3 },
            layoutsFlags: 0,
        });
        frame(0, 0, 0);
        // ACTION! opens round 1 via the centerprint path.
        s.parser.onCenterPrint?.({ clientNum: 18, text: 'ACTION!' });
        // Round plays out; scores update, then the end broadcast closes it.
        frame(0, 1, 0);
        s.parser.onPrint?.({ level: 2, text: 'The round is over:\n' });
        const snap = s.stats.snapshot();
        expect(snap.rounds).toHaveLength(2);
        expect(snap.rounds[1].teamScores).toEqual({ team1: 0, team2: 1, team3: 0 });
        expect(snap.rounds[1].winner).toBe('team2');
        expect(snap.rounds[1].endedAt).toBeDefined();
        s.dispose();
    });
});
