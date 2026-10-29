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
