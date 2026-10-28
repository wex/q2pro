import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { MVD_MAGIC, MvdOp, SVCMD_MASK } from './protocol';

// ── Options / events ────────────────────────────────────────────────

export interface MvdDemoReaderOptions {
    /** Emit one message per server tick instead of as-fast-as-possible. */
    realtime?: boolean;
    /** Tick interval when realtime=true (ms, default 100 = 10 Hz). */
    tickMs?: number;
}

export interface MvdDemoReaderEventMap {
    message: [data: Buffer];
    end: [];
    error: [err: Error];
    /** Fired after seek() — payload is the snapped keyframe index. */
    seek: [index: number];
    pause: [];
    resume: [];
}

// ── Typed emitter via declaration merging ───────────────────────────

export declare interface MvdDemoReader {
    on<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
    once<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
    emit<K extends keyof MvdDemoReaderEventMap>(event: K, ...args: MvdDemoReaderEventMap[K]): boolean;
    off<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
}

/** seek() clamps the speed multiplier into this range. */
const MIN_SPEED = 0.25;
const MAX_SPEED = 8;

/**
 * Reads a Q2Pro `.mvd2` demo file and emits each framed MVD message payload
 * (the same bytes a GTV `streamData` event delivers), so they can be fed into
 * `MvdFrameParser.parse()` for testing or offline analysis.
 *
 * File layout (see `doc/mvd-system.md` §3.1):
 *   [4 bytes]  'MVD2' magic
 *   repeated:
 *     [uint16 LE] length  (0 = EOF)
 *     [N bytes]   MVD command payload
 *
 * Playback controls: pause()/resume() gate the realtime timer; seek(n)
 * snaps back to the nearest preceding keyframe (mvd_serverdata /
 * mvd_framenodelta) because frames are delta-compressed — consumers must
 * reset their parser on the `seek` event; setSpeed(m) scales the tick.
 */
export class MvdDemoReader extends EventEmitter {
    private readonly opts: Required<MvdDemoReaderOptions>;
    private messages: Buffer[] = [];
    private keyframes: number[] = [];
    private cursor = 0;
    private tickTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;
    private finished = false;
    private isPaused = false;
    private speedMult = 1;

    constructor(options: MvdDemoReaderOptions = {}) {
        super();
        this.opts = {
            realtime: options.realtime ?? false,
            tickMs: options.tickMs ?? 100,
        };
    }

    /** Load `.mvd2` file from disk and start emitting. */
    play(filePath: string): this {
        let buf: Buffer;
        try {
            buf = fs.readFileSync(filePath);
        } catch (err) {
            queueMicrotask(() => this.emit('error', err instanceof Error ? err : new Error(String(err))));
            return this;
        }
        return this.playBuffer(buf);
    }

    /** Parse an in-memory `.mvd2` buffer and start emitting. */
    playBuffer(buf: Buffer): this {
        // Clear any prior tick timer before resetting state (re-play safety).
        this.clearTickTimer();
        this.stopped = false;
        this.finished = false;
        this.isPaused = false;
        this.speedMult = 1;
        this.messages = [];
        this.cursor = 0;

        try {
            this.decode(buf);
        } catch (err) {
            queueMicrotask(() => this.emit('error', err instanceof Error ? err : new Error(String(err))));
            return this;
        }

        if (this.opts.realtime) {
            this.scheduleTick();
        } else {
            queueMicrotask(() => this.drainAll());
        }
        return this;
    }

    /** Stop pacing and drop any queued messages. */
    stop(): void {
        this.stopped = true;
        this.clearTickTimer();
        this.messages = [];
        this.keyframes = [];
        this.cursor = 0;
        this.finished = false;
        this.isPaused = false;
    }

    // ── Playback controls ──────────────────────────────────────────

    /** Index of the next message to emit. */
    get position(): number {
        return this.cursor;
    }

    /** Total messages in the loaded demo. */
    get messageCount(): number {
        return this.messages.length;
    }

    get paused(): boolean {
        return this.isPaused;
    }

    /** Current speed multiplier (clamped to [0.25, 8]). */
    get speed(): number {
        return this.speedMult;
    }

    /** Freeze emission without losing position (realtime mode only). */
    pause(): void {
        if (this.isPaused || this.stopped || this.finished) return;
        this.isPaused = true;
        this.clearTickTimer();
        this.emit('pause');
    }

    /** Resume from the paused position. */
    resume(): void {
        if (!this.isPaused || this.stopped) return;
        this.isPaused = false;
        this.emit('resume');
        if (this.cursor >= this.messages.length) {
            this.finish();
            return;
        }
        if (this.opts.realtime) {
            this.scheduleTick();
        } else {
            queueMicrotask(() => this.drainAll());
        }
    }

    /**
     * Move the cursor to the nearest keyframe at or before `targetIndex`.
     * Frames are delta-compressed, so seeking to an arbitrary message would
     * feed the parser deltas against a baseline it never saw — the snapped
     * index is returned and emitted via `seek` (listeners should reset their
     * parser state). After a natural 'end' the buffer is retained precisely
     * so seeking backward is possible.
     */
    seek(targetIndex: number): number {
        if (this.messages.length === 0) return this.cursor;
        const target = Math.max(0, Math.min(targetIndex, this.messages.length - 1));
        let snapped = 0;
        for (const k of this.keyframes) {
            if (k > target) break;
            snapped = k;
        }
        this.cursor = snapped;
        this.stopped = false;
        this.finished = false;
        this.emit('seek', snapped);
        if (!this.isPaused) {
            if (this.opts.realtime) {
                this.scheduleTick();
            } else {
                queueMicrotask(() => this.drainAll());
            }
        }
        return snapped;
    }

    /** Scale the realtime tick interval; returns the clamped multiplier. */
    setSpeed(mult: number): number {
        if (!Number.isFinite(mult)) return this.speedMult;
        this.speedMult = Math.min(MAX_SPEED, Math.max(MIN_SPEED, mult));
        if (this.tickTimer) {
            this.scheduleTick();
        }
        return this.speedMult;
    }

    // ── Internal ───────────────────────────────────────────────────

    /** Validate magic and split the buffer into message payloads. */
    private decode(buf: Buffer): void {
        if (buf.length < 4 || !buf.subarray(0, 4).equals(MVD_MAGIC)) {
            throw new Error('Not a Q2Pro .mvd2 file (missing MVD2 magic)');
        }

        let p = 4;
        while (p + 2 <= buf.length) {
            const len = buf.readUInt16LE(p);
            p += 2;
            if (len === 0) break; // EOF marker
            if (p + len > buf.length) {
                throw new Error(`Truncated .mvd2: message of ${len} bytes extends past EOF`);
            }
            // Copy out of the source so callers can retain the slice safely.
            this.messages.push(Buffer.from(buf.subarray(p, p + len)));
            p += len;
        }
        this.buildKeyframes();
    }

    /**
     * Indices whose first opcode resets delta state: mvd_serverdata is the
     * canonical baseline; mvd_framenodelta is a reserved whole-frame form.
     * Seek snaps to the last such index ≤ target (or 0 when none precede it).
     */
    private buildKeyframes(): void {
        this.keyframes = [];
        for (let i = 0; i < this.messages.length; i++) {
            const m = this.messages[i];
            if (m.length === 0) continue;
            const op = m[0] & SVCMD_MASK;
            if (op === MvdOp.ServerData || op === MvdOp.FrameNoDelta) {
                this.keyframes.push(i);
            }
        }
    }

    private drainAll(): void {
        if (this.stopped) return;
        while (this.cursor < this.messages.length) {
            if (this.stopped) return;
            this.emit('message', this.messages[this.cursor++]);
        }
        this.finish();
    }

    private scheduleTick(): void {
        this.clearTickTimer();
        this.tickTimer = setTimeout(() => this.tick(), this.opts.tickMs / this.speedMult);
    }

    private clearTickTimer(): void {
        if (this.tickTimer) {
            clearTimeout(this.tickTimer);
            this.tickTimer = null;
        }
    }

    private tick(): void {
        if (this.stopped || this.isPaused) return;
        if (this.cursor >= this.messages.length) {
            this.finish();
            return;
        }
        this.emit('message', this.messages[this.cursor++]);
        this.scheduleTick();
    }

    /** Natural end of buffer: timer halts but messages stay for seeking. */
    private finish(): void {
        this.clearTickTimer();
        if (this.finished) return;
        this.finished = true;
        this.emit('end');
    }
}
