import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadPalette, loadWalTexture, parseWal, rgbaToPngDataUrl, walToRgba } from '../src/wal';

function buildWal(name: string, w: number, h: number, pixels: number[]): Buffer {
    const buf = Buffer.alloc(100 + w * h);
    buf.write(name, 0, 'ascii');
    buf.writeUInt32LE(w, 32);
    buf.writeUInt32LE(h, 36);
    buf.writeUInt32LE(100, 40); // mip-0 offset
    Buffer.from(pixels).copy(buf, 100);
    return buf;
}

/** 768-byte palette where entry i is (i, i, i) grayscale except a few fixed ones. */
function buildPalette(): Uint8Array {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
        pal[i * 3 + 0] = i;
        pal[i * 3 + 1] = i;
        pal[i * 3 + 2] = i;
    }
    pal[0] = 0x10; pal[1] = 0x20; pal[2] = 0x30; // entry 0 → rgb(16,32,48)
    return pal;
}

describe('parseWal', () => {
    test('parses name, dimensions and mip-0 pixels', () => {
        const wal = parseWal(buildWal('test/wall', 4, 2, [1, 2, 3, 4, 5, 6, 7, 8]));
        expect(wal.name).toBe('test/wall');
        expect(wal.width).toBe(4);
        expect(wal.height).toBe(2);
        expect(Array.from(wal.pixels)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test('rejects a buffer smaller than the header', () => {
        expect(() => parseWal(Buffer.alloc(99))).toThrow(/too small/);
    });

    test('rejects pixel data that runs past the buffer', () => {
        const wal = buildWal('bad', 64, 64, []); // claims 64x64 but holds 0 pixels
        wal.writeUInt32LE(100, 40);
        // buffer only has 100 bytes; offset+4096 > length
        expect(() => parseWal(wal.subarray(0, 100))).toThrow(/out of bounds/);
    });
});

describe('walToRgba', () => {
    test('maps palette indices to RGB and makes index 255 transparent', () => {
        const pal = buildPalette();
        const rgba = walToRgba(new Uint8Array([0, 5, 255]), 3, 1, pal);
        expect(Array.from(rgba.subarray(0, 4))).toEqual([0x10, 0x20, 0x30, 255]);
        expect(Array.from(rgba.subarray(4, 8))).toEqual([5, 5, 5, 255]);
        expect(rgba[11]).toBe(0); // alpha of index 255
    });
});

describe('rgbaToPngDataUrl', () => {
    test('emits a valid PNG signature behind a data URL', () => {
        const url = rgbaToPngDataUrl(new Uint8Array([255, 0, 0, 255]), 1, 1);
        expect(url.startsWith('data:image/png;base64,')).toBe(true);
        const png = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
        expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
        expect(png.readUInt32BE(16)).toBe(1); // width
        expect(png.readUInt32BE(20)).toBe(1); // height
    });
});

describe('loadPalette / loadWalTexture', () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('loadPalette takes the last 768 bytes and caches by path', () => {
        const pcx = path.join(tmpDir, 'colormap.pcx');
        const pal = buildPalette();
        fs.writeFileSync(pcx, Buffer.concat([Buffer.alloc(16), Buffer.from(pal)]));
        const a = loadPalette(pcx);
        expect(a[0]).toBe(0x10);
        expect(loadPalette(pcx)).toBe(a); // same reference — cached
    });

    test('loadPalette throws on an undersized file', () => {
        const pcx = path.join(tmpDir, 'tiny.pcx');
        fs.writeFileSync(pcx, Buffer.alloc(100));
        expect(() => loadPalette(pcx)).toThrow(/too small/);
    });

    test('loadWalTexture returns a PNG data URL for an existing wal', () => {
        const texDir = path.join(tmpDir, 'textures');
        fs.mkdirSync(path.join(texDir, 'test'), { recursive: true });
        fs.writeFileSync(
            path.join(texDir, 'test', 'synth.wal'),
            buildWal('test/synth', 2, 2, [0, 1, 2, 255]),
        );
        const tex = loadWalTexture(texDir, 'test/synth', buildPalette());
        expect(tex).not.toBeNull();
        expect(tex!.width).toBe(2);
        expect(tex!.height).toBe(2);
        expect(tex!.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    });

    test('loadWalTexture returns null for a missing wal', () => {
        expect(loadWalTexture(tmpDir, 'nope/missing', buildPalette())).toBeNull();
    });
});
