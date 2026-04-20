import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// ─── PCX palette extraction ──────────────────────────────────────────────────
//
// The Quake 2 palette is stored as the last 768 bytes of colormap.pcx
// (256 entries × 3 bytes RGB).

const PCX_PALETTE_SIZE = 768;

let paletteCache: Uint8Array | null = null;

export function loadPalette(colormapPath: string): Uint8Array {
  if (paletteCache) return paletteCache;
  const buf = fs.readFileSync(colormapPath);
  if (buf.length < PCX_PALETTE_SIZE) {
    throw new Error(`colormap.pcx too small (${buf.length} bytes)`);
  }
  paletteCache = new Uint8Array(buf.buffer, buf.byteOffset + buf.length - PCX_PALETTE_SIZE, PCX_PALETTE_SIZE);
  return paletteCache;
}

// ─── WAL header layout ──────────────────────────────────────────────────────
//
// From inc/format/wal.h (miptex_t):
//   char     name[32]       (32 bytes)
//   uint32   width          ( 4 bytes)
//   uint32   height         ( 4 bytes)
//   uint32   offsets[4]     (16 bytes)  — four mip levels
//   char     animname[32]   (32 bytes)
//   uint32   flags          ( 4 bytes)
//   uint32   contents       ( 4 bytes)
//   uint32   value          ( 4 bytes)
// Total header: 100 bytes

const WAL_HEADER_SIZE = 100;

export interface WalTexture {
  name: string;
  width: number;
  height: number;
  pixels: Uint8Array; // mip level 0, 8-bit indexed
}

export function parseWal(buf: Buffer): WalTexture {
  if (buf.length < WAL_HEADER_SIZE) {
    throw new Error('WAL file too small');
  }

  const nameEnd = buf.indexOf(0, 0);
  const name = buf
    .subarray(0, nameEnd >= 0 && nameEnd < 32 ? nameEnd : 32)
    .toString('ascii');

  const width = buf.readUInt32LE(32);
  const height = buf.readUInt32LE(36);
  const offset0 = buf.readUInt32LE(40);

  const pixelCount = width * height;
  if (offset0 + pixelCount > buf.length) {
    throw new Error('WAL pixel data out of bounds');
  }

  const pixels = new Uint8Array(buf.buffer, buf.byteOffset + offset0, pixelCount);
  return { name, width, height, pixels };
}

// ─── Pixel conversion ────────────────────────────────────────────────────────

export function walToRgba(pixels: Uint8Array, width: number, height: number, palette: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const idx = pixels[i];
    rgba[i * 4 + 0] = palette[idx * 3 + 0];
    rgba[i * 4 + 1] = palette[idx * 3 + 1];
    rgba[i * 4 + 2] = palette[idx * 3 + 2];
    rgba[i * 4 + 3] = idx === 255 ? 0 : 255; // index 255 = transparent
  }
  return rgba;
}

// ─── Minimal PNG encoder (uses Node built-in zlib) ───────────────────────────

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBytes, Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function rgbaToPngDataUrl(rgba: Uint8Array, width: number, height: number): string {
  // Build raw image data with filter byte (0 = None) per row
  const rowLen = width * 4 + 1; // filter byte + RGBA
  const raw = Buffer.alloc(height * rowLen);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0; // filter: None
    rgba.copyWithin(0, 0); // noop, just for clarity
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * rowLen + 1);
  }

  const compressed = zlib.deflateSync(raw);

  // IHDR: width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ]);

  return 'data:image/png;base64,' + png.toString('base64');
}

// ─── High-level loader ───────────────────────────────────────────────────────

export interface LoadedTexture {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Attempt to load a WAL texture from the textures directory.
 * `texName` is the BSP texinfo name (e.g. "gengo/grass").
 * Returns null if the file is not found.
 */
export function loadWalTexture(texturesDir: string, texName: string, palette: Uint8Array): LoadedTexture | null {
  const walPath = path.join(texturesDir, texName + '.wal');
  let buf: Buffer;
  try {
    buf = fs.readFileSync(walPath);
  } catch {
    return null;
  }

  try {
    const wal = parseWal(buf);
    const rgba = walToRgba(wal.pixels, wal.width, wal.height, palette);
    const dataUrl = rgbaToPngDataUrl(rgba, wal.width, wal.height);
    return { dataUrl, width: wal.width, height: wal.height };
  } catch (e) {
    console.error(`[WAL] Failed to parse ${walPath}: ${e}`);
    return null;
  }
}
