import * as path from 'node:path';
import * as fs from 'node:fs';

/** Absolute path to the canonical demo fixture shipped with the repo. */
export const DEMO_PATH = path.resolve(__dirname, '..', '..', 'assets', 'demos', 'demo.mvd2');

export function readDemoBytes(): Buffer {
    return fs.readFileSync(DEMO_PATH);
}

/**
 * Build a synthetic `.mvd2` buffer from pre-formed message payloads.
 * Appends a uint16(0) EOF marker when `withEof` is true.
 */
export function buildMvd2(messages: Buffer[], withEof = true): Buffer {
    const magic = Buffer.from('MVD2', 'ascii');
    const parts: Buffer[] = [magic];
    for (const msg of messages) {
        const len = Buffer.alloc(2);
        len.writeUInt16LE(msg.length);
        parts.push(len, msg);
    }
    if (withEof) {
        const eof = Buffer.alloc(2);
        eof.writeUInt16LE(0);
        parts.push(eof);
    }
    return Buffer.concat(parts);
}
