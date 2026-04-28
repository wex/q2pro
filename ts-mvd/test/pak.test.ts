import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { PakIndex } from '../src/pak';

// ─── Synthesizers ─────────────────────────────────────────────────

interface SynthFile { name: string; data: Buffer; }

function buildPak(files: SynthFile[]): Buffer {
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'ascii');
    const dataParts: Buffer[] = [];
    let cursor = 12;
    const dirEntries: Buffer[] = [];
    for (const f of files) {
        const entry = Buffer.alloc(64);
        entry.write(f.name, 0, 'ascii');
        entry.writeUInt32LE(cursor, 56);
        entry.writeUInt32LE(f.data.length, 60);
        dirEntries.push(entry);
        dataParts.push(f.data);
        cursor += f.data.length;
    }
    const dir = Buffer.concat(dirEntries);
    header.writeUInt32LE(cursor, 4);   // dirofs
    header.writeUInt32LE(dir.length, 8); // dirlen
    return Buffer.concat([header, ...dataParts, dir]);
}

interface SynthZipFile extends SynthFile { method: 0 | 8; }

function buildZip(files: SynthZipFile[]): Buffer {
    const localChunks: Buffer[] = [];
    const cdChunks: Buffer[] = [];
    const offsets: number[] = [];
    let cursor = 0;
    for (const f of files) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const stored = f.method === 8 ? zlib.deflateRawSync(f.data) : f.data;
        // CRC32
        const crc = crc32(f.data);
        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);          // version needed
        lfh.writeUInt16LE(0, 6);           // flags
        lfh.writeUInt16LE(f.method, 8);
        lfh.writeUInt16LE(0, 10);          // mod time
        lfh.writeUInt16LE(0, 12);          // mod date
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(stored.length, 18);
        lfh.writeUInt32LE(f.data.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);
        offsets.push(cursor);
        const localBlock = Buffer.concat([lfh, nameBuf, stored]);
        localChunks.push(localBlock);
        cursor += localBlock.length;

        const cdh = Buffer.alloc(46);
        cdh.writeUInt32LE(0x02014b50, 0);
        cdh.writeUInt16LE(20, 4);
        cdh.writeUInt16LE(20, 6);
        cdh.writeUInt16LE(0, 8);
        cdh.writeUInt16LE(f.method, 10);
        cdh.writeUInt16LE(0, 12);
        cdh.writeUInt16LE(0, 14);
        cdh.writeUInt32LE(crc, 16);
        cdh.writeUInt32LE(stored.length, 20);
        cdh.writeUInt32LE(f.data.length, 24);
        cdh.writeUInt16LE(nameBuf.length, 28);
        cdh.writeUInt16LE(0, 30);
        cdh.writeUInt16LE(0, 32);
        cdh.writeUInt16LE(0, 34);
        cdh.writeUInt16LE(0, 36);
        cdh.writeUInt32LE(0, 38);
        cdh.writeUInt32LE(offsets[offsets.length - 1], 42);
        cdChunks.push(Buffer.concat([cdh, nameBuf]));
    }
    const cdStart = cursor;
    const cd = Buffer.concat(cdChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...localChunks, cd, eocd]);
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// ─── Suite ───────────────────────────────────────────────────────

describe('PakIndex', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pak-test-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns empty index for missing directory', () => {
        const idx = PakIndex.load(path.join(tmpDir, 'does-not-exist'));
        expect(idx.size).toBe(0);
        expect(idx.archives.length).toBe(0);
    });

    test('reads PACK entries verbatim', () => {
        const a = Buffer.from('hello world');
        const b = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x80]);
        const pak = buildPak([
            { name: 'maps/foo.bsp', data: a },
            { name: 'textures/bar.wal', data: b },
        ]);
        fs.writeFileSync(path.join(tmpDir, 'pak0.pak'), pak);

        const idx = PakIndex.load(tmpDir);
        expect(idx.size).toBe(2);
        expect(idx.has('maps/foo.bsp')).toBe(true);
        expect(idx.read('maps/foo.bsp')).toEqual(a);
        expect(idx.read('TEXTURES/BAR.WAL')).toEqual(b); // case-insensitive
        expect(idx.read('missing')).toBeNull();
        idx.close();
    });

    test('reads ZIP entries with both stored and deflate methods', () => {
        const stored = Buffer.from('raw bytes ABCDEF');
        const compressible = Buffer.alloc(2048, 0x42); // highly compressible
        const zip = buildZip([
            { name: 'pics/colormap.pcx', data: stored, method: 0 },
            { name: 'maps/big.bsp', data: compressible, method: 8 },
        ]);
        fs.writeFileSync(path.join(tmpDir, 'pak2.pkz'), zip);

        const idx = PakIndex.load(tmpDir);
        expect(idx.size).toBe(2);
        expect(idx.read('pics/colormap.pcx')).toEqual(stored);
        expect(idx.read('maps/big.bsp')).toEqual(compressible);
        idx.close();
    });

    test('later archive overrides earlier one', () => {
        const old = Buffer.from('old');
        const fresh = Buffer.from('fresh');
        fs.writeFileSync(
            path.join(tmpDir, 'pak0.pak'),
            buildPak([{ name: 'shared.dat', data: old }]),
        );
        fs.writeFileSync(
            path.join(tmpDir, 'pak1.pkz'),
            buildZip([{ name: 'shared.dat', data: fresh, method: 0 }]),
        );

        const idx = PakIndex.load(tmpDir);
        expect(idx.read('shared.dat')).toEqual(fresh);
        idx.close();
    });

    test('skips directory entries in ZIP', () => {
        // Manually craft a zip with a dir entry; reuse buildZip then nothing,
        // simpler: ensure a name ending in / is ignored.
        const zip = buildZip([
            { name: 'subdir/', data: Buffer.alloc(0), method: 0 },
            { name: 'subdir/file.txt', data: Buffer.from('hi'), method: 0 },
        ]);
        fs.writeFileSync(path.join(tmpDir, 'a.pkz'), zip);
        const idx = PakIndex.load(tmpDir);
        expect(idx.size).toBe(1);
        expect(idx.read('subdir/file.txt')).toEqual(Buffer.from('hi'));
        idx.close();
    });

    // Smoke test against the bundled paks (skipped if absent).
    const REAL_PAKS = path.resolve(__dirname, '..', 'paks');
    const realAvail = fs.existsSync(path.join(REAL_PAKS, 'pak0.pak'));
    (realAvail ? test : test.skip)('indexes the bundled pak0.pak', () => {
        const idx = PakIndex.load(REAL_PAKS);
        expect(idx.size).toBeGreaterThan(0);
        expect(idx.archives.length).toBeGreaterThan(0);
        idx.close();
    });
});
