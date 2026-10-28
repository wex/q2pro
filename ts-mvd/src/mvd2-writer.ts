import * as fs from 'node:fs';
import * as path from 'node:path';
import { MVD_MAGIC } from './protocol';

/**
 * Writes a Q2Pro `.mvd2` demo file from live `streamData` payloads.
 *
 * File layout (same as `MvdDemoReader` consumes, see `doc/mvd-system.md`):
 *   [4 bytes]  'MVD2' magic
 *   repeated:
 *     [uint16 LE] length  (0 = EOF)
 *     [N bytes]   MVD command payload
 *
 * The payload bytes are byte-identical to what a GTV `GTS_STREAM_DATA`
 * message carries, so recording is a straight framing pass — no re-encode.
 * Synchronous writes are fine at ~10 msgs/sec × a few KB each.
 */
export class Mvd2Writer {
    private fd: number | null = null;
    private filePath = '';
    /** Messages written so far (excluding header/EOF marker). */
    messages = 0;
    /** Total file bytes including header and EOF marker. */
    bytesWritten = 0;

    get recording(): boolean {
        return this.fd !== null;
    }

    /** Absolute path of the file currently being written ("" when idle). */
    get file(): string {
        return this.filePath;
    }

    /** Open `filePath` for writing; creates the parent directory. */
    open(filePath: string): void {
        if (this.fd !== null) {
            throw new Error(`already recording to ${this.filePath}`);
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        this.fd = fs.openSync(filePath, 'w');
        this.filePath = filePath;
        this.messages = 0;
        this.bytesWritten = 0;
        fs.writeSync(this.fd, MVD_MAGIC);
        this.bytesWritten += MVD_MAGIC.length;
    }

    /**
     * Append one framed message. Empty payloads are skipped: on the wire an
     * empty `GTS_STREAM_DATA` is a suspend marker, while in a .mvd2 file a
     * zero length is the EOF marker — writing it would truncate playback.
     */
    writeMessage(payload: Buffer): void {
        if (this.fd === null || payload.length === 0) return;
        const hdr = Buffer.allocUnsafe(2);
        hdr.writeUInt16LE(payload.length, 0);
        fs.writeSync(this.fd, hdr);
        fs.writeSync(this.fd, payload);
        this.messages++;
        this.bytesWritten += 2 + payload.length;
    }

    /** Write the EOF marker and close. Returns final stats, or null if idle. */
    close(): { file: string; messages: number; bytes: number } | null {
        if (this.fd === null) return null;
        fs.writeSync(this.fd, Buffer.alloc(2));
        fs.closeSync(this.fd);
        this.fd = null;
        this.bytesWritten += 2;
        return { file: this.filePath, messages: this.messages, bytes: this.bytesWritten };
    }
}
