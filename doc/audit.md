# ts-mvd project audit

> Superseded by `/AUDIT.md` (2026-10-28): its confirmed bugs 1–2 and
> robustness findings 3–5 are FIXED on the `fix/cs-layout-selection`,
> `fix/inner-svc-ops`, `fix/error-event-guard`, `fix/client-close-dedup`
> and `fix/sse-hygiene` branches.

Date: 2026-07-29.
Scope: everything under `ts-mvd/` (source, tests, configs, browser client, docs that describe them).
Method: full source read-through, cross-check of protocol constants against the C reference in
`inc/server/mvd/protocol.h` / `src/server/mvd/*`, plus a verification run.

## Verification snapshot

- `npm run build` — passes (tsc, no errors).
- `npx jest` — 7 suites, 69 tests, all pass (with `forceExit`, as configured).
- Protocol constants spot-checked against the C reference: `GTV_PROTOCOL_VERSION` (0xED04),
  `MAX_GTS_MSGLEN` (0x8000), `MvdOp` ordering, unicast/multicast framing — all match.

## Bugs (correctness)

### 1. Reconnect backoff never escalates — `src/client.ts` — FIXED
`connect()` no longer zeroes `reconnectAttempt` on auto-reconnect; user-initiated
`connect()` and successful `handleHello` reset it. Soft-close paths preserve backoff.

### 2. Protocol errors permanently disable auto-reconnect — `src/client.ts` — FIXED
Recoverable errors soft-close (allow reconnect): `BAD_MAGIC`, `OVERSIZE`,
`UNKNOWN_OPCODE`, `GTS_ERROR`, `BAD_HELLO`, server `Disconnect`, end-of-stream.
Fatal (no reconnect): user `disconnect()`, `BadRequest`, `NoAccess`.

### 3. Manual `disconnect()` never emits `close` — `src/client.ts` + `src/app.ts` — FIXED
`disconnect()` emits `close` (guarded against double-fire). App SSE `liveStop` fires
on user `/disconnect`.

### 4. `MvdDemoReader` leaks the tick timer on re-play — `src/demo.ts` — FIXED
`playBuffer()` clears any existing `tickTimer` before starting a new interval.

### 5. Palette cache ignores the path argument — `src/wal.ts` — FIXED
`loadPalette` keys the cache by `colormapPath`.

### 6. `texture-export.ts` executes `process.exit()` on import — FIXED
CLI guarded like `map-render.ts` (`argv` endsWith check).

### 7. Stale players when everyone leaves — `src/app.ts` — FIXED
`players.clear()` runs every frame (including empty); regression covered in `app.test.ts`.

### 8. A corrupt BSP crashes the whole server — `src/app.ts` / `src/bsp.ts` — FIXED
`loadBsp` is inside the `/maps` try/catch; `BspFile.load` validates lump extents.

### 9. `BufferReader.readBytes` silently clamps — `src/buffer.ts` — FIXED
Throws `RangeError` on under-read.

## Security / robustness (HTTP control surface)

- **Path traversal in `POST /replay?file=`** — FIXED (confined to `DEMOS_DIR`, basename only).
- **Hardcoded GTV password** — FIXED (password from Connect UI / `POST /connect` body;
  init default `''`; not echoed in responses).
- **SPA fallback masks 404s** — FIXED (paths with extensions return real 404).
- **SSE hygiene** — open (keepalive / backpressure); low priority for a LAN tool.
- **`/connect` TOCTOU** — open; low impact.
- **Pak overlay dir is never removed** — open.

## Parser / protocol gaps

- **Unknown MVD opcode silently discards** — FIXED (`onParseWarning` +
  `parseWarningCount` / `droppedBytes` on `MvdFrameParser`).
- **No `GTF_DEFLATE` support** — open (limitation); README no longer claims it.
- **Chat dedup can swallow legitimate duplicates** — known trade-off (`doc/chat-dedup.md`).
- **`classifyChat` regex boundary** — FIXED (`\x20-\x7E`).

## Dead / redundant code

- Unused `lines` map — already gone.
- `onFrame` chaining — open (EventEmitter refactor deferred).
- `handleHello` duplicates `sendStreamStart` — FIXED (calls `sendStreamStart()`).
- `wal.ts` noop `copyWithin` — FIXED (removed).
- Identical grid opacity ternary / unused `tex` param — FIXED.
- `showMarkers` not wired — FIXED (`?markers` on `/maps`).

## Documentation drift

- **`ts-mvd/README.md`** — FIXED (removed fake `deflate` / `example.ts`; documents
  Connect password + `npm run app`).
- **`AGENTS.md`** — FIXED (module map + reference docs synced).
- **`doc/testing.md`**, **`doc/demo-replay.md`**, **`doc/chat-dedup.md`**,
  **`doc/mvd-system.md`** — synced with reconnect / connect / replay security behaviour.

## Test coverage gaps

Addressed for bugs 1–9 / security: reconnect backoff + fatal vs soft errors,
double `play()`, `readBytes` under-read, BSP lump bounds, replay traversal, SPA 404,
password not leaked from `/connect`. Still open: broad `wal`/`map-render`/`texture-export`
pipeline coverage and SSE heartbeat.

## Process notes

- `.gitignore` narrowed: ignore `assets/demos/2026-*.mvd2` recordings only (fixtures stay trackable).
- `public/app.js` TS migration — open / long-term.

## Prioritized TODO list (post-fix status)

1. ~~Fix reconnect backoff / error-path reconnect policy~~ done.
2. ~~Emit `close` on manual disconnect~~ done.
3. ~~Confine `POST /replay`; GTV password from Connect UI~~ done.
4. ~~Wrap `loadBsp` / bsp lump bounds~~ done.
5. ~~Guard `texture-export.ts` CLI~~ done.
6. ~~Palette cache by path; empty-frame players clear~~ done.
7. ~~`readBytes` throw; demo tick timer clear~~ done.
8. ~~Parse-warning hook for unknown opcodes~~ done.
9. ~~Sync docs (README / AGENTS / drift)~~ done.
10. Map-pipeline tests (`wal` / `map-render` / `/maps` happy path) — open follow-up.
11. EventEmitter callbacks on `MvdFrameParser` — open follow-up.
12. Optional: `GTF_DEFLATE`, demo pause/seek, SSE heartbeat, pak overlay cleanup — open.
