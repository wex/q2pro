import { EventEmitter } from 'node:events';

// ── Mock node:net before importing the client ───────────────────────

class FakeSocket extends EventEmitter {
    destroyed = false;
    connected = false;
    writes: Buffer[] = [];
    connectArgs: Array<[number, string]> = [];

    connect(port: number, host: string): this {
        this.connectArgs.push([port, host]);
        return this;
    }
    write(data: Buffer): boolean {
        this.writes.push(Buffer.from(data));
        return true;
    }
    destroy(): void {
        this.destroyed = true;
        this.emit('close');
    }
    end(): void {
        this.emit('close');
    }
    setNoDelay(): void { /* noop */ }
    setKeepAlive(): void { /* noop */ }
}

const lastSocket: { instance: FakeSocket | null } = { instance: null };

jest.mock('net', () => {
    return {
        Socket: class {
            constructor() {
                const s = new FakeSocket();
                lastSocket.instance = s;
                return s as unknown as object;
            }
        },
    };
});

// Import after the mock is in place.
import { MvdClient } from '../src/client';
import { ClientState, MVD_MAGIC, GtvServerOp, GTV_PROTOCOL_VERSION } from '../src/protocol';
import { BufferWriter } from '../src/buffer';

function makeClient() {
    return new MvdClient({
        host: 'test.local',
        port: 27999,
        username: 'u',
        password: 'p',
        autoReconnect: false,
    });
}

function framedMessage(op: GtvServerOp, payload: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from([op]), payload]);
    const len = Buffer.alloc(2);
    len.writeUInt16LE(body.length);
    return Buffer.concat([len, body]);
}

describe('MvdClient state machine', () => {
    const created: MvdClient[] = [];
    function make() {
        const c = makeClient();
        created.push(c);
        return c;
    }

    afterEach(() => {
        for (const c of created) c.disconnect();
        created.length = 0;
        lastSocket.instance = null;
    });

    test('initial state is Disconnected', () => {
        const c = make();
        expect(c.state).toBe(ClientState.Disconnected);
    });

    test('setTarget succeeds while disconnected, fails once connecting', () => {
        const c = make();
        expect(c.setTarget('h1', 1000)).toBe(true);
        c.connect();
        expect(c.state).toBe(ClientState.Connecting);
        expect(c.setTarget('h2', 2000)).toBe(false);
        // Verify the failed setTarget did not take effect: the stored
        // connectArgs reflect the first setTarget.
        expect(lastSocket.instance?.connectArgs[0]).toEqual([1000, 'h1']);
    });

    test('connect() transitions Disconnected → Connecting and emits stateChange', () => {
        const c = make();
        const transitions: Array<{ from: ClientState; to: ClientState }> = [];
        c.on('stateChange', (ev) => transitions.push(ev));
        c.connect();
        expect(c.state).toBe(ClientState.Connecting);
        expect(transitions[0]).toEqual({ from: ClientState.Disconnected, to: ClientState.Connecting });
    });

    test('socket `connect` event writes MVD_MAGIC and sets Connected state', () => {
        const c = make();
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');
        expect(c.state).toBe(ClientState.Connected);
        expect(sock.writes).toHaveLength(1);
        expect(sock.writes[0]).toEqual(MVD_MAGIC);
    });

    test('wrong magic echo emits BAD_MAGIC error and disconnects', () => {
        const c = make();
        const errors: Array<{ code: string }> = [];
        c.on('error', (e) => errors.push(e));
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');
        // Server echoes wrong 4-byte magic
        sock.emit('data', Buffer.from('XXXX', 'ascii'));
        expect(errors.some((e) => e.code === 'BAD_MAGIC')).toBe(true);
        expect(c.state).toBe(ClientState.Disconnected);
    });

    test('happy path: magic echo + Hello payload → Preparing + hello event', () => {
        const c = make();
        const helloFlags: number[] = [];
        c.on('hello', (f) => helloFlags.push(f));
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');

        // Echo magic back. After processing the echo the client auto-sends
        // its own Hello and advances straight from Connected → Preparing.
        sock.emit('data', MVD_MAGIC);
        expect(c.state).toBe(ClientState.Preparing);

        // Build a GTS_HELLO framed message: opcode + uint32 flags (payload
        // needs at least 4 bytes).
        const w = new BufferWriter();
        w.writeInt32LE(0);
        const helloFrame = framedMessage(GtvServerOp.Hello, w.toBuffer());
        sock.emit('data', helloFrame);

        expect(helloFlags).toEqual([0]);
        // Client auto-sends StreamStart and transitions to Ready.
        expect(c.state).toBe(ClientState.Ready);
    });

    test('disconnect() returns state to Disconnected and prevents reconnect', () => {
        const c = make();
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');
        c.disconnect();
        expect(c.state).toBe(ClientState.Disconnected);
        // Further socket events must not drive the state back up.
        sock.emit('close');
        expect(c.state).toBe(ClientState.Disconnected);
    });

    test('disconnect() emits close exactly once', () => {
        const c = make();
        let closes = 0;
        c.on('close', () => closes++);
        c.connect();
        c.disconnect();
        expect(closes).toBe(1);
        // Socket destroy would have fired close if listeners remained — ensure no double emit.
        lastSocket.instance?.emit('close');
        expect(closes).toBe(1);
    });

    test('setTarget updates password while disconnected', () => {
        const c = make();
        expect(c.setTarget('h', 1, 'secret')).toBe(true);
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');
        sock.emit('data', MVD_MAGIC);
        const all = Buffer.concat(sock.writes);
        expect(all.includes(Buffer.from('secret\0', 'ascii'))).toBe(true);
    });

    test('autoReconnect soft-closes on BAD_MAGIC and escalates backoff', () => {
        jest.useFakeTimers();
        const c = new MvdClient({
            host: 'test.local',
            port: 27999,
            autoReconnect: true,
            reconnectDelay: 1000,
            reconnectMaxDelay: 10_000,
        });
        created.push(c);
        c.on('error', () => { /* expected */ });
        const closes: number[] = [];
        c.on('close', () => closes.push(1));

        c.connect();
        let sock = lastSocket.instance!;
        sock.emit('connect');
        sock.emit('data', Buffer.from('XXXX', 'ascii'));
        expect(c.state).toBe(ClientState.Disconnected);
        expect(closes.length).toBe(1);

        // First reconnect after ~1000ms (attempt 0 → delay 1000).
        jest.advanceTimersByTime(999);
        expect(lastSocket.instance).toBe(sock); // not yet
        jest.advanceTimersByTime(1);
        expect(lastSocket.instance).not.toBe(sock);
        sock = lastSocket.instance!;
        sock.emit('connect');
        sock.emit('data', Buffer.from('YYYY', 'ascii'));

        // Second reconnect after 1500ms (attempt 1 → 1000*1.5).
        jest.advanceTimersByTime(1499);
        const mid = lastSocket.instance;
        jest.advanceTimersByTime(1);
        expect(lastSocket.instance).not.toBe(mid);

        jest.useRealTimers();
        c.disconnect();
    });

    test('BadRequest hard-disconnects and does not auto-reconnect', () => {
        jest.useFakeTimers();
        const c = new MvdClient({
            host: 'test.local',
            port: 27999,
            autoReconnect: true,
            reconnectDelay: 100,
        });
        created.push(c);
        c.on('error', () => { /* expected */ });
        c.connect();
        const sock = lastSocket.instance!;
        sock.emit('connect');
        sock.emit('data', MVD_MAGIC);
        sock.emit('data', framedMessage(GtvServerOp.BadRequest, Buffer.alloc(0)));
        expect(c.state).toBe(ClientState.Disconnected);

        const before = lastSocket.instance;
        jest.advanceTimersByTime(5000);
        expect(lastSocket.instance).toBe(before);
        jest.useRealTimers();
    });

    test('GTV_PROTOCOL_VERSION constant is exported and numeric', () => {
        // Sanity: ensures we didn't break the exported constant surface the
        // tests rely on.
        expect(typeof GTV_PROTOCOL_VERSION).toBe('number');
    });
});
