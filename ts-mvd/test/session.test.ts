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
