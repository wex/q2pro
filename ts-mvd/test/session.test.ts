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
