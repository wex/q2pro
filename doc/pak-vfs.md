# Pak / Pkz Asset Fallback

Read-only virtual file system for Quake 2 `.pak` archives and `.pkz`
(ZIP) archives, used by `ts-mvd/src/app.ts` to serve maps and textures
when the corresponding files are missing under `ts-mvd/maps/` or
`ts-mvd/textures/`.

## Scope

- Index every `.pak` / `.pkz` in `ts-mvd/paks/` once at process start.
- Filesystem under `maps/` and `textures/` keeps priority; the index is a
  fallback only.
- Hook is confined to `app.ts`; `bsp.ts`, `wal.ts`, and `map-render.ts`
  are unchanged. Pak-sourced assets are extracted to a per-process
  overlay directory under `os.tmpdir()` so the existing buffer/path-based
  parsers can be reused as-is.

## Format support

### `.pak` (Quake 2 PACK)

- Header: `"PACK"` magic, `int32le dirOffset`, `int32le dirLength`.
- Each directory entry is 64 bytes: 56-byte NUL-padded name, then
  `int32le filePos`, `int32le fileLen`. Data is always stored
  uncompressed.

### `.pkz` (ZIP)

- End of Central Directory record (`0x06054b50`) is located by scanning
  the trailing 64 KiB of the archive.
- Central directory entries (`0x02014b50`) are walked to collect file
  metadata and local-header offsets.
- Local File Header (`0x04034b50`) is read on demand to compute the data
  offset (skipping `name_len + extra_len`).
- Compression: `0` (stored) and `8` (deflate) are supported. ZIP64 size
  sentinels (`0xFFFFFFFF`) raise an error — none of the bundled paks
  approach that limit.
- Directory entries (names ending with `/`) are skipped.

## Override semantics

Archives are loaded in lexicographic order by filename, so
`pak0 < pak1 < pak2.pak < pak2.pkz`. When the same logical name appears
in multiple archives, the later one wins. This matches Q2Pro's
`fs_addgamedir` behaviour for archive priority.

Logical names are normalised to lowercase forward-slash paths for both
`PakIndex.has` and `PakIndex.read`.

## Runtime flow

1. At module load `app.ts` runs `PakIndex.load(PAKS_DIR)` and logs the
   archive/entry counts.
2. `loadBsp(name)` first checks `maps/<name>.bsp` on disk. On miss it
   calls `pakIndex.read('maps/' + name + '.bsp')` and feeds the buffer
   to `BspFile.load`.
3. `prepareTexturesDir(bsp)` inspects `bsp.texinfo` and:
   - returns `TEXTURES_DIR` directly when every required `.wal` is on
     disk, else
   - mirrors the required wals into the overlay (symlink for
     fs-resident files, written buffers for pak-sourced files) and
     returns the overlay path. The overlay path is then passed to
     `generateMapSvg`/`loadWalTexture` unchanged.
4. `prepareColormap()` returns `colormap.pcx` if present, otherwise
   tries `pics/colormap.pcx` and `colormap.pcx` in the pak index.
5. `GET /paks` returns `{ archives, entryCount }` for sanity checks.

The overlay directory is created with `fs.mkdtempSync` per process and
shared across requests; entries are materialised on first use only.

## Module surface (`ts-mvd/src/pak.ts`)

```ts
class PakIndex {
  static load(paksDir: string): PakIndex;
  readonly size: number;
  readonly archives: readonly string[];
  has(name: string): boolean;
  get(name: string): PakEntry | undefined;
  read(name: string): Buffer | null;
  close(): void;
}
```

`PakIndex` keeps one open file descriptor per archive; call `close()`
to release them in long-running tooling. The HTTP app keeps the index
alive for the lifetime of the process.

## Out of scope

- Writing into archives.
- ZIP64, encrypted ZIP, non-deflate compression methods.
- Refactoring `wal.ts` / `bsp.ts` to consume buffers from a generic VFS.
