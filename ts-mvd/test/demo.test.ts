import { MvdDemoReader } from '../src/demo';
import { MvdOp } from '../src/protocol';
import { DEMO_PATH, buildMvd2 } from './helpers/fixtures';

function waitForEvent<T>(emitter: MvdDemoReader, event: 'end' | 'error'): Promise<T> {
    return new Promise((resolve) => {
        emitter.once(event as 'end', (...args: unknown[]) => resolve(args[0] as T));
    });
}

describe('MvdDemoReader.playBuffer magic validation', () => {
    test('emits error when magic is wrong', async () => {
        const reader = new MvdDemoReader();
        const errP = waitForEvent<Error>(reader, 'error');
        reader.playBuffer(Buffer.from('XXXX_whatever', 'ascii'));
        const err = await errP;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/MVD2 magic/);
    });

    test('emits error on truncated message', async () => {
        // MVD2 + uint16(10) claims 10 bytes but we only provide 4.
        const buf = Buffer.concat([
            Buffer.from('MVD2', 'ascii'),
            Buffer.from([10, 0, 1, 2, 3, 4]),
        ]);
        const reader = new MvdDemoReader();
        const errP = waitForEvent<Error>(reader, 'error');
        reader.playBuffer(buf);
        const err = await errP;
        expect(err.message).toMatch(/Truncated/);
    });

    test('stops at uint16(0) EOF marker and ignores trailing garbage', async () => {
        const payload = Buffer.from([0x10, 0x20]);
        const mvd = buildMvd2([payload], true);
        // Append garbage past the EOF marker.
        const withGarbage = Buffer.concat([mvd, Buffer.from([0xff, 0xff, 0xff])]);

        const reader = new MvdDemoReader();
        const msgs: Buffer[] = [];
        reader.on('message', (m) => msgs.push(m));
        const endP = waitForEvent<void>(reader, 'end');
        reader.playBuffer(withGarbage);
        await endP;
        expect(msgs).toHaveLength(1);
        expect(Array.from(msgs[0])).toEqual([0x10, 0x20]);
    });
});

describe('MvdDemoReader with demo.mvd2 fixture', () => {
    test('non-realtime drain emits messages then end exactly once', async () => {
        const reader = new MvdDemoReader({ realtime: false });
        const msgs: Buffer[] = [];
        let endCount = 0;
        reader.on('message', (m) => msgs.push(m));
        reader.on('end', () => endCount++);
        reader.play(DEMO_PATH);
        // Wait a macrotask cycle to let drainAll complete.
        await new Promise((r) => setImmediate(r));
        expect(msgs.length).toBeGreaterThan(0);
        expect(endCount).toBe(1);
        // Every message payload should be non-empty.
        expect(msgs.every((m) => m.length > 0)).toBe(true);
    });
});

describe('MvdDemoReader realtime pacing', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('emits one message per tick', () => {
        const msgs = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3])];
        const mvd = buildMvd2(msgs, true);

        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        reader.playBuffer(mvd);

        expect(received).toHaveLength(0);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(2);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(3);
    });

    test('stop() halts further emissions and skips end', () => {
        const msgs = [Buffer.from([1]), Buffer.from([2])];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        let endFired = false;
        reader.on('message', (m) => received.push(m));
        reader.on('end', () => (endFired = true));
        reader.playBuffer(buildMvd2(msgs, true));

        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);
        reader.stop();
        jest.advanceTimersByTime(100);
        expect(received).toHaveLength(1);
        expect(endFired).toBe(false);
    });

    test('re-play clears the previous tick timer (no double-speed)', () => {
        const msgs = [Buffer.from([1]), Buffer.from([2]), Buffer.from([3]), Buffer.from([4])];
        const mvd = buildMvd2(msgs, true);
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));

        reader.playBuffer(mvd);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);

        // Start a fresh play without stop() — must not stack intervals.
        reader.playBuffer(mvd);
        received.length = 0;
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(2);
    });
});

describe('MvdDemoReader playback controls', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const SD = Buffer.from([MvdOp.ServerData]);
    const N = () => Buffer.from([MvdOp.Nop]);

    test('pause() freezes emission, resume() continues from the cursor', () => {
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        reader.playBuffer(buildMvd2([SD, N(), N(), N()]));

        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);
        reader.pause();
        jest.advanceTimersByTime(100);
        expect(received).toHaveLength(1);
        expect(reader.paused).toBe(true);

        reader.resume();
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(2);
    });

    test('seek() snaps back to the preceding serverdata keyframe', () => {
        // Indices: 0=SD, 1..2=N, 3=SD, 4=N → keyframes [0, 3].
        const msgs = [SD, N(), N(), SD, N()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        let snappedTo = -1;
        reader.on('message', (m) => received.push(m));
        reader.on('seek', (i) => (snappedTo = i));
        reader.playBuffer(buildMvd2(msgs));

        jest.advanceTimersByTime(20);
        expect(received).toHaveLength(2);

        const snapped = reader.seek(4);
        expect(snapped).toBe(3);
        expect(snappedTo).toBe(3);
        expect(reader.position).toBe(3);

        received.length = 0;
        jest.advanceTimersByTime(10);
        expect(received).toEqual([SD]); // replays from message 3
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(2);
    });

    test('seek() while paused moves the cursor without resuming', () => {
        const msgs = [SD, N(), N(), N()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        reader.playBuffer(buildMvd2(msgs));
        reader.pause();
        const snapped = reader.seek(3);
        expect(snapped).toBe(0); // only keyframe is index 0
        expect(reader.paused).toBe(true);
        jest.advanceTimersByTime(50);
        expect(reader.position).toBe(0); // nothing emitted while paused
    });

    test('seek() after natural end replays retained messages', () => {
        const msgs = [SD, N(), N()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        let endCount = 0;
        reader.on('message', (m) => received.push(m));
        reader.on('end', () => endCount++);
        reader.playBuffer(buildMvd2(msgs));

        jest.advanceTimersByTime(100);
        expect(endCount).toBe(1);
        expect(received).toHaveLength(3);

        received.length = 0;
        reader.seek(0);
        jest.advanceTimersByTime(30);
        expect(received).toHaveLength(3);
    });

    test('setSpeed() scales the tick interval and clamps to [0.25, 8]', () => {
        const msgs = [SD, N(), N(), N(), N()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        reader.playBuffer(buildMvd2(msgs));

        reader.setSpeed(2);
        jest.advanceTimersByTime(10); // two 5 ms ticks
        expect(received).toHaveLength(2);

        expect(reader.setSpeed(100)).toBe(8);
        expect(reader.speed).toBe(8);
        expect(reader.setSpeed(0.01)).toBe(0.25);
        expect(reader.setSpeed(NaN)).toBe(0.25);
    });

    test('non-realtime seek drains from the snapped keyframe', async () => {
        jest.useRealTimers(); // drainAll runs via queueMicrotask, which fake timers intercept
        const msgs = [SD, N(), SD, N()];
        const reader = new MvdDemoReader({ realtime: false });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        const endP = waitForEvent<void>(reader, 'end');
        reader.playBuffer(buildMvd2(msgs));
        await endP;
        expect(received).toHaveLength(4);

        received.length = 0;
        const end2 = waitForEvent<void>(reader, 'end');
        reader.seek(3);
        await end2;
        expect(received).toEqual([SD, N()]); // messages 2 and 3 replayed
    });
});
