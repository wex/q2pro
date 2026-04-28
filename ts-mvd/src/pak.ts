import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// ─── Q2 PAK + Zip-based PKZ asset indexer ────────────────────────────────────
//
// Provides a read-only virtual file system over a directory of `.pak`
// (Quake 2 PACK) and `.pkz` (ZIP) archives. Names are normalized to forward
// slashes and lowercased. Later archives in sort order override earlier ones,
// matching Q2Pro semantics (pak0 < pak1 < pak2.pak < pak2.pkz).

export type PakMethod = 0 | 8; // 0 = stored, 8 = deflate

export interface PakEntry {
    archive: string;        // absolute path to the source archive
    offset: number;         // byte offset of file data within the archive
    compressedSize: number;
    uncompressedSize: number;
    method: PakMethod;
}

interface ArchiveHandle {
    fd: number;
    path: string;
    size: number;
}

const PAK_MAGIC = 0x4b434150; // "PACK" little-endian
const ZIP_LFH_SIG = 0x04034b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

export class PakIndex {
    private readonly entries = new Map<string, PakEntry>();
    private readonly handles = new Map<string, ArchiveHandle>();
    private readonly archiveOrder: string[] = [];

    /** Number of merged entries (after override resolution). */
    get size(): number { return this.entries.size; }

    /** Absolute paths of archives loaded into this index, in load order. */
    get archives(): readonly string[] { return this.archiveOrder; }

    /**
     * Synchronously scan `paksDir` for `.pak` and `.pkz` files and merge their
     * directories. Returns an empty index if the directory does not exist.
     */
    static load(paksDir: string): PakIndex {
        const idx = new PakIndex();
        if (!fs.existsSync(paksDir)) return idx;
        const stat = fs.statSync(paksDir);
        if (!stat.isDirectory()) return idx;

        const names = fs.readdirSync(paksDir)
            .filter((n) => /\.(pak|pkz)$/i.test(n))
            .sort((a, b) => a.localeCompare(b));

        for (const name of names) {
            const archivePath = path.join(paksDir, name);
            try {
                idx.addArchive(archivePath);
            } catch (err) {
                console.warn(`[pak] Failed to index ${archivePath}: ${(err as Error).message}`);
            }
        }
        return idx;
    }

    has(name: string): boolean {
        return this.entries.has(normalizeName(name));
    }

    get(name: string): PakEntry | undefined {
        return this.entries.get(normalizeName(name));
    }

    /** Read and (if needed) decompress an entry. Returns null if not found. */
    read(name: string): Buffer | null {
        const entry = this.entries.get(normalizeName(name));
        if (!entry) return null;
        const handle = this.handles.get(entry.archive);
        if (!handle) {
            throw new Error(`pak archive handle missing: ${entry.archive}`);
        }
        const compressed = Buffer.alloc(entry.compressedSize);
        if (entry.compressedSize > 0) {
            fs.readSync(handle.fd, compressed, 0, entry.compressedSize, entry.offset);
        }
        if (entry.method === 0) return compressed;
        if (entry.method === 8) return zlib.inflateRawSync(compressed);
        throw new Error(`Unsupported compression method ${entry.method} in ${entry.archive}`);
    }

    /** Close all open archive file descriptors. Safe to call multiple times. */
    close(): void {
        for (const h of this.handles.values()) {
            try { fs.closeSync(h.fd); } catch { /* ignore */ }
        }
        this.handles.clear();
        this.entries.clear();
        this.archiveOrder.length = 0;
    }

    private addArchive(archivePath: string): void {
        const fd = fs.openSync(archivePath, 'r');
        const size = fs.fstatSync(fd).size;
        const handle: ArchiveHandle = { fd, path: archivePath, size };
        try {
            const ext = path.extname(archivePath).toLowerCase();
            const entries = ext === '.pkz'
                ? readZipDirectory(handle)
                : readPakDirectory(handle);
            this.handles.set(archivePath, handle);
            this.archiveOrder.push(archivePath);
            for (const [name, entry] of entries) {
                this.entries.set(name, entry);
            }
        } catch (err) {
            fs.closeSync(fd);
            throw err;
        }
    }
}

function normalizeName(name: string): string {
    return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

// ─── PAK directory ───────────────────────────────────────────────────────────

function readPakDirectory(h: ArchiveHandle): Array<[string, PakEntry]> {
    const header = Buffer.alloc(12);
    fs.readSync(h.fd, header, 0, 12, 0);
    const magic = header.readUInt32LE(0);
    if (magic !== PAK_MAGIC) {
        throw new Error(`bad PAK magic in ${h.path}`);
    }
    const dirOfs = header.readUInt32LE(4);
    const dirLen = header.readUInt32LE(8);
    if (dirLen % 64 !== 0) throw new Error(`bad PAK dirlen in ${h.path}`);
    if (dirOfs + dirLen > h.size) throw new Error(`PAK directory out of bounds in ${h.path}`);
    const dir = Buffer.alloc(dirLen);
    if (dirLen > 0) fs.readSync(h.fd, dir, 0, dirLen, dirOfs);

    const out: Array<[string, PakEntry]> = [];
    const count = dirLen / 64;
    for (let i = 0; i < count; i++) {
        const p = i * 64;
        const nameEnd = dir.indexOf(0, p);
        const rawName = dir.subarray(p, nameEnd >= 0 && nameEnd < p + 56 ? nameEnd : p + 56).toString('ascii');
        const filepos = dir.readUInt32LE(p + 56);
        const filelen = dir.readUInt32LE(p + 60);
        out.push([normalizeName(rawName), {
            archive: h.path,
            offset: filepos,
            compressedSize: filelen,
            uncompressedSize: filelen,
            method: 0,
        }]);
    }
    return out;
}

// ─── ZIP directory ───────────────────────────────────────────────────────────

function readZipDirectory(h: ArchiveHandle): Array<[string, PakEntry]> {
    const eocd = findEocd(h);
    const cdSize = eocd.readUInt32LE(12);
    const cdOffset = eocd.readUInt32LE(16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new Error(`ZIP64 not supported in ${h.path}`);
    }
    if (cdOffset + cdSize > h.size) {
        throw new Error(`ZIP central directory out of bounds in ${h.path}`);
    }
    const cd = Buffer.alloc(cdSize);
    if (cdSize > 0) fs.readSync(h.fd, cd, 0, cdSize, cdOffset);

    const out: Array<[string, PakEntry]> = [];
    let p = 0;
    while (p + 46 <= cd.length) {
        const sig = cd.readUInt32LE(p);
        if (sig !== ZIP_CDH_SIG) break;
        const method = cd.readUInt16LE(p + 10);
        const compSize = cd.readUInt32LE(p + 20);
        const uncompSize = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const localOfs = cd.readUInt32LE(p + 42);
        if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOfs === 0xffffffff) {
            throw new Error(`ZIP64 not supported in ${h.path}`);
        }
        const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;

        // Skip directory entries (trailing slash).
        if (name.endsWith('/')) continue;
        if (method !== 0 && method !== 8) {
            throw new Error(`Unsupported ZIP method ${method} for ${name} in ${h.path}`);
        }

        // Resolve actual data offset by reading the local file header.
        const lfh = Buffer.alloc(30);
        fs.readSync(h.fd, lfh, 0, 30, localOfs);
        if (lfh.readUInt32LE(0) !== ZIP_LFH_SIG) {
            throw new Error(`Bad ZIP local header at ${localOfs} in ${h.path}`);
        }
        const lNameLen = lfh.readUInt16LE(26);
        const lExtraLen = lfh.readUInt16LE(28);
        const dataOffset = localOfs + 30 + lNameLen + lExtraLen;

        out.push([normalizeName(name), {
            archive: h.path,
            offset: dataOffset,
            compressedSize: compSize,
            uncompressedSize: uncompSize,
            method: method as PakMethod,
        }]);
    }
    return out;
}

function findEocd(h: ArchiveHandle): Buffer {
    const maxComment = 0xffff;
    const scanLen = Math.min(h.size, 22 + maxComment);
    const scanStart = h.size - scanLen;
    const buf = Buffer.alloc(scanLen);
    if (scanLen > 0) fs.readSync(h.fd, buf, 0, scanLen, scanStart);
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === ZIP_EOCD_SIG) {
            const commentLen = buf.readUInt16LE(i + 20);
            if (i + 22 + commentLen === buf.length) {
                return buf.subarray(i, i + 22);
            }
        }
    }
    throw new Error(`ZIP EOCD not found in ${h.path}`);
}
