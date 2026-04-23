# texture-export

Small CLI that extracts the list of distinct, renderable texture names from a
Quake 2 BSP file and prints them as `textures/<name>.wal` paths.

Source: `ts-mvd/src/texture-export.ts`.

## Scope

- Input: a single `.bsp` file (standard `IBSP` or extended `QBSP`, version 38).
- Output: one `textures/<name>.wal` path per line on stdout, sorted and deduped.
- Status/errors go to stderr; non-zero exit on failure.

## Usage

```bash
npx tsx src/texture-export.ts <file.bsp>
```

Redirect to a file if desired:

```bash
npx tsx src/texture-export.ts maps/q2dm1.bsp > q2dm1-textures.txt
```

## Protocol touchpoints

- Reads only the BSP `texinfo` lump (lump 5). No face or surfedge traversal is
  required: the `texinfo` lump already lists every texture reference used by
  faces in worldspawn and inline submodels.
- Disk layout is handled by `BspFile` in `ts-mvd/src/bsp.ts` (76-byte texinfo
  stride, 32-byte null-terminated name).

## Filtering

Texinfo entries are excluded when any of these surface flags are set (they are
editor/compiler hints or non-drawn surfaces, not real textures to ship):

- `SURF_NODRAW` (0x080)
- `SURF_SKIP`   (0x200)
- `SURF_HINT`   (0x100)

Empty names (after trimming) are also skipped.

## Performance

Single linear pass over `texinfo` with a `Set<string>` dedupe and one final
sort — O(n log n) for typically <1k entries, runs in a few milliseconds.

## Out of scope

- Does **not** extract `.wal` files from pak/zip archives; it only emits the
  list of expected asset paths.
- Does not resolve animation chains (`texinfo.next`) — animated frames that are
  never directly referenced by a face will not appear.
