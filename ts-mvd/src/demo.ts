import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { MVD_MAGIC } from './protocol';

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
}

// ── Typed emitter via declaration merging ───────────────────────────

export declare interface MvdDemoReader {
    on<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
    once<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
    emit<K extends keyof MvdDemoReaderEventMap>(event: K, ...args: MvdDemoReaderEventMap[K]): boolean;
    off<K extends keyof MvdDemoReaderEventMap>(event: K, listener: (...args: MvdDemoReaderEventMap[K]) => void): this;
}

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
 */
export class MvdDemoReader extends EventEmitter {
    private readonly opts: Required<MvdDemoReaderOptions>;
    private messages: Buffer[] = [];
    private cursor = 0;
    private tickTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;

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
        this.stopped = false;
        this.messages = [];
        this.cursor = 0;

        try {
            this.decode(buf);
        } catch (err) {
            queueMicrotask(() => this.emit('error', err instanceof Error ? err : new Error(String(err))));
            return this;
        }

        if (this.opts.realtime) {
            this.tickTimer = setInterval(() => this.tick(), this.opts.tickMs);
        } else {
            queueMicrotask(() => this.drainAll());
        }
        return this;
    }

    /** Stop pacing and drop any queued messages. */
    stop(): void {
        this.stopped = true;
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        this.messages = [];
        this.cursor = 0;
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
            if (len === 0) return; // EOF marker
            if (p + len > buf.length) {
                throw new Error(`Truncated .mvd2: message of ${len} bytes extends past EOF`);
            }
            // Copy out of the source so callers can retain the slice safely.
            this.messages.push(Buffer.from(buf.subarray(p, p + len)));
            p += len;
        }
        // No explicit EOF marker — treat clean end-of-buffer as end.
    }

    private drainAll(): void {
        if (this.stopped) return;
        for (const msg of this.messages) {
            if (this.stopped) return;
            this.emit('message', msg);
        }
        this.messages = [];
        this.emit('end');
    }

    private tick(): void {
        if (this.stopped) return;
        if (this.cursor >= this.messages.length) {
            this.stop();
            this.emit('end');
            return;
        }
        this.emit('message', this.messages[this.cursor++]);
    }
}
