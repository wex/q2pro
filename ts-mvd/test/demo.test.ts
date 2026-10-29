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

    const F = () => Buffer.from([MvdOp.Frame]);
    const N = () => Buffer.from([MvdOp.Nop]);
    const SD = Buffer.from([MvdOp.ServerData]);
    const CS = Buffer.from([MvdOp.ConfigString]);

    test('paces one server frame per tick — frameless messages ride the burst', () => {
        // [SD, F, CS, F, N, N, F] → bursts end after each frame-leading
        // message: tick1 SD+F, tick2 CS+F, tick3 N+N+F.
        const msgs = [SD, F(), CS, F(), N(), N(), F()];
        const mvd = buildMvd2(msgs, true);

        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        reader.playBuffer(mvd);

        expect(received).toHaveLength(0);
        jest.advanceTimersByTime(10);
        expect(received).toEqual([SD, msgs[1]]);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(4);
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(7);
    });

    test('stop() halts further emissions and skips end', () => {
        const msgs = [F(), F()];
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
        const msgs = [F(), F(), F(), F()];
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
    const F = () => Buffer.from([MvdOp.Frame]);

    test('pause() freezes emission, resume() continues from the cursor', () => {
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const received: Buffer[] = [];
        reader.on('message', (m) => received.push(m));
        reader.playBuffer(buildMvd2([F(), N(), N(), F()]));

        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(1);
        reader.pause();
        jest.advanceTimersByTime(100);
        expect(received).toHaveLength(1);
        expect(reader.paused).toBe(true);

        reader.resume();
        jest.advanceTimersByTime(10);
        expect(received).toHaveLength(4); // N+N+F in one burst
    });

    test('seek() snaps to a keyframe, catch-up is silent, seeked lands on target', () => {
        // Indices: 0=SD, 1..2=F, 3=SD, 4..5=F → keyframes [0, 3].
        const msgs = [SD, F(), F(), SD, F(), F()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const seen: Array<{ m: Buffer; catchup: boolean }> = [];
        let snappedTo = -1;
        let seekedTo = -1;
        reader.on('message', (m, catchup) => seen.push({ m, catchup }));
        reader.on('seek', (i) => (snappedTo = i));
        reader.on('seeked', (i) => (seekedTo = i));
        reader.playBuffer(buildMvd2(msgs));

        jest.advanceTimersByTime(20); // tick1 SD+F, tick2 F
        expect(seen).toHaveLength(3);

        const snapped = reader.seek(5);
        expect(snapped).toBe(3);
        expect(snappedTo).toBe(3);
        expect(reader.position).toBe(5);
        expect(seekedTo).toBe(5);
        // Messages 3,4 re-emitted silently; realtime resumes at 5.
        expect(seen.slice(3)).toEqual([
            { m: msgs[3], catchup: true },
            { m: msgs[4], catchup: true },
        ]);

        jest.advanceTimersByTime(10);
        expect(seen[5]).toEqual({ m: msgs[5], catchup: false });
    });

    test('seek() while paused rebuilds silently without resuming', () => {
        const msgs = [SD, F(), F(), F()];
        const reader = new MvdDemoReader({ realtime: true, tickMs: 10 });
        const seen: Array<{ m: Buffer; catchup: boolean }> = [];
        reader.on('message', (m, catchup) => seen.push({ m, catchup }));
        reader.playBuffer(buildMvd2(msgs));
        reader.pause();
        const snapped = reader.seek(2);
        expect(snapped).toBe(0);
        expect(reader.paused).toBe(true);
        // Catch-up still feeds the parser (paused scrubbing), flagged silent.
        expect(seen).toEqual([
            { m: msgs[0], catchup: true },
            { m: msgs[1], catchup: true },
        ]);
        expect(reader.position).toBe(2);
        jest.advanceTimersByTime(50);
        expect(seen).toHaveLength(2); // nothing emitted while paused
    });

    test('seek() after natural end replays retained messages', () => {
        const msgs = [SD, F(), N()];
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
        const msgs = [F(), F(), F(), F(), F()];
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
