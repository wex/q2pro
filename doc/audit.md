# ts-mvd project audit

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

### 1. Reconnect backoff never escalates — `src/client.ts`
`connect()` resets `reconnectAttempt = 0` on every call (line 121). `scheduleReconnect()` computes
the delay from `reconnectAttempt` and then increments it, but the timer callback calls `connect()`,
which zeroes the counter again. Result: the exponential backoff
(`reconnectDelay * 1.5^attempt`, capped by `reconnectMaxDelay`) is dead code — a permanently
unreachable server is retried at a constant 5 s forever. Fix: only reset the counter on a
*successful* handshake (e.g. in `handleHello`), or track "user-initiated connect" separately.

### 2. Protocol errors permanently disable auto-reconnect — `src/client.ts`
Every error path (`BAD_MAGIC`, `OVERSIZE`, `GTS_ERROR`, `UNKNOWN_OPCODE`, …) calls
`this.disconnect()`, which sets `destroyed = true`. `onTcpClose` then refuses to schedule a
reconnect even when `autoReconnect: true`. A transient server-side error therefore kills the
session for good, while a plain TCP drop reconnects fine. Decide intentionally which errors are
fatal; currently all of them are.

### 3. Manual `disconnect()` never emits `close` — `src/client.ts` + `src/app.ts`
`disconnect()` → `cleanup()` calls `socket.removeAllListeners()` before `socket.destroy()`, so the
TCP close handler (the only place that emits the client's `close` event) never runs.
`app.ts` broadcasts the `liveStop` SSE event from `client.on('close')`, so browsers are never told
the live stream ended when the user POSTs `/disconnect`. Emit `close` from `disconnect()` itself
(guarded so it doesn't double-fire).

### 4. `MvdDemoReader` leaks the tick timer on re-play — `src/demo.ts`
`playBuffer()` resets `stopped`/`messages`/`cursor` but does not clear an existing `tickTimer`
before creating a new `setInterval`. Calling `play()` twice on the same reader leaves two timers
running and emits messages at double speed. `app.ts` happens to always create a fresh reader, so
this is latent — but the public API allows it. Call `this.stop()` (minus the state reset) at the
top of `playBuffer()`.

### 5. Palette cache ignores the path argument — `src/wal.ts`
`loadPalette(colormapPath)` memoizes into a module-global `paletteCache` keyed by nothing. The
first call wins forever; a later call with a different `colormapPath` (which `prepareColormap()`
in `app.ts` can produce — disk file vs. pak-extracted fallback) silently returns the wrong
palette. Key the cache by path, or cache at the call site.

### 6. `texture-export.ts` executes `process.exit()` on import
The module ends with a top-level `process.exit(main(process.argv.slice(2)))` (line 46) with no
`require.main === module` guard. It is compiled into `dist/`, so any consumer that imports
`dist/texture-export.js` kills its own process with a usage error. Contrast with `map-render.ts`,
which guards its CLI block. Add the same guard.

### 7. Stale players when everyone leaves — `src/app.ts`
The base `parser.onFrame` handler starts with `if (ev.players.length === 0) return;` (line 104),
which skips the `players.clear()` further down. When the last player disappears, the module-level
`players` map (used by the SSE `snapshot` on new connections and by `CombatFxResolver`) keeps the
last known positions indefinitely. Move the clear/rebuild above the early return.

### 8. A corrupt BSP crashes the whole server — `src/app.ts`
In the `/maps/{name}` handler, `loadBsp(mapName)` (line 742) runs *outside* the `try` that guards
rendering. `BspFile.load` does no bounds-checking of lump offsets/lengths against the buffer, so a
truncated or malformed `.bsp` throws a `RangeError` out of the request handler and takes down the
process. Wrap `loadBsp` in the try, and/or validate lump extents in `bsp.ts`.

### 9. `BufferReader.readBytes` silently clamps — `src/buffer.ts`
`readBytes(n)` uses `subarray`, which clamps to the buffer end, then advances `offset` past the
end (making `remaining` negative). A truncated unicast/multicast payload in `frame.ts` therefore
yields a short buffer instead of an error, and misparses inside can be attributed to the wrong
cause. Throw on under-read (all other `read*` methods already throw via Node's bounds checks).

## Security / robustness (HTTP control surface)

The app binds `0.0.0.0:8080` with no authentication. That may be acceptable for a LAN tool, but
the following compound it:

- **Path traversal in `POST /replay?file=`** — `src/app.ts` line 698: any value containing a slash
  is passed to `path.resolve(__dirname, '..', requested)`, so `file=../../../../etc/passwd` (or an
  absolute path) is accepted, its existence disclosed via 404-vs-202, and the file is read and
  parsed. Restrict to `DEMOS_DIR` (resolve, then verify the result is inside the directory).
- **Hardcoded GTV password** — `src/app.ts` line 38 ships `password: 'aq2world'` in source.
  Read from an environment variable.
- **SPA fallback masks 404s** — unknown paths (including `/foo.png`) return `index.html` with
  status 200 and, for non-html/js/css extensions, `Content-Type: application/octet-stream`.
  Return a real 404 for paths with extensions, and add a traversal guard (currently saved only by
  `path.join` + the existence check falling back to `index.html`).
- **SSE hygiene** — no keepalive comment/heartbeat (idle proxies may drop connections) and
  `sseBroadcast` ignores `res.write` backpressure. Low priority for a LAN tool.
- **`/connect` TOCTOU** — the replay/state checks run before the async body read; two concurrent
  POSTs can interleave. `client.connect()` is idempotent-ish, so impact is low.
- **Pak overlay dir is never removed** — `fs.mkdtempSync` per process (line 495), never cleaned
  up on exit; accumulates in `$TMPDIR` across runs.

## Parser / protocol gaps

- **Unknown MVD opcode silently discards the rest of the buffer** — `frame.ts` line 332-333
  (`default: return;`). There is no counter, log, or callback, so protocol drift would look like
  "nothing happened". Same for unknown inner `svc_` ops and unknown temp-entity types (those at
  least stop only the inner payload, which is documented). Add an `onParseWarning`-style hook or
  a dropped-bytes counter.
- **No `GTF_DEFLATE` support** — `client.ts` never requests compression, so long streams use more
  bandwidth than the reference client. Fine as a limitation, but the README claims otherwise
  (see below).
- **Chat dedup can swallow legitimate duplicates** — `emitPrint` dedupes identical
  `(level, text)` within one tick. Two different players sending the exact same chat line in the
  same server tick will collapse to one. Known trade-off (documented in `doc/chat-dedup.md`),
  listed here for completeness.
- **`classifyChat` regex boundary** — `/[^\x20-\x80]/g` keeps 0x80 (a control char in most
  encodings) while stripping 0x7F. Harmless in practice because `BufferReader.readString` decodes
  as `ascii` (masking to 7 bits), but the range should be `\x20-\x7E`.

## Dead / redundant code

- `src/app.ts` lines 106-114: `const lines = ev.players.map(...)` is computed and never used.
- `src/app.ts`: `parser.onFrame` is reassigned three times via captured `origOnFrame` /
  `origOnFrame2` chaining (lines 200, 402). Fragile — insertion order matters and
  `resetPipelineState()` can't rebuild it. Consider making `MvdFrameParser` an `EventEmitter` so
  handlers compose naturally.
- `src/client.ts` `handleHello` (lines 337-340) duplicates the body of `sendStreamStart()`
  instead of calling it.
- `src/wal.ts` line 112: `rgba.copyWithin(0, 0); // noop, just for clarity` — delete.
- `src/map-render.ts` line 300/312: `opacity="${isAxis ? 0.9 : 0.9}"` — both branches identical;
  `computePatternTransform` takes a `tex` parameter it never uses.
- `src/map-render.ts` exposes a `showMarkers` option that `app.ts` never wires to a query
  parameter (only `grid` and `notextures` exist). Either expose `?markers` or drop the option.

## Documentation drift

- **`ts-mvd/README.md`** documents a `deflate` client option (usage example line 29, options
  table line 180: "Request zlib compression, default true"). No such option exists in
  `MvdClientOptions` and the client never requests `GTF_DEFLATE`. Also, "Run Example" points to
  `src/example.ts`, which does not exist (the actual entry point is `src/app.ts` via
  `npm run app`).
- **`AGENTS.md`** says `app.test.ts` runs supertest against "the exported Express app" — it's a
  plain `node:http` server, no Express. The module map omits `combat-fx.ts`; the test-suite list
  omits `combat-fx.test.ts` and `pak.test.ts`; the reference-doc list omits `doc/combat-fx.md`,
  `doc/chat-dedup.md`, `doc/player-lock.md`, `doc/texture-toggle.md`,
  `doc/player-health-and-death-icon.md`, `doc/ui-team-colours-and-gametime.md`.
- **`doc/testing.md`** layout section lists five suites; `combat-fx.test.ts` and `pak.test.ts`
  are missing.

## Test coverage gaps

Untested modules: `bsp.ts`, `wal.ts`, `map-render.ts`, `texture-export.ts` (together ~1,100
lines — the whole map-rendering pipeline). Also untested behaviours:

- Client reconnect scheduling/backoff (would have caught bug 1) and error-path `destroyed`
  semantics (bug 2).
- `GET /maps/{name}` end-to-end (fixture BSPs exist under `assets/maps/`), including the corrupt
  BSP case (bug 8).
- `MvdDemoReader.play()` called twice on one instance (bug 4).
- Truncated-payload behaviour of `BufferReader.readBytes` (bug 9).

## Process notes

- `AGENTS.md` mandates one feature per Git branch, but the last five feature/fix commits
  (`click-to-lock`, `texture toggle`, etc.) were committed directly to `main`, which is currently
  5 commits ahead of `origin/main` and unpushed.
- `.gitignore` lists `/assets` even though the canonical fixtures
  (`assets/demos/demo.mvd2`, `assets/maps/*.bsp`, …) are tracked. That works (ignore rules don't
  affect tracked files) but means any *new* fixture must be force-added — easy to lose. Prefer a
  narrower ignore (e.g. only `assets/demos/2026-*.mvd2` recordings).
- `public/app.js` is ~1,350 lines of hand-maintained vanilla JS with no lint/type coverage,
  duplicating constants from `src/` (e.g. `CS_PLAYERSKINS_*`, MZ table). Long-term candidate for
  a small TS build target sharing `src/protocol.ts`.

## Prioritized TODO list

1. Fix reconnect backoff reset and decide error-path reconnect policy (`client.ts`, bugs 1-2).
2. Emit `close` on manual disconnect so the UI gets `liveStop` (bug 3).
3. Confine `POST /replay?file=` to `DEMOS_DIR`; move the GTV password to an env var.
4. Wrap `loadBsp` in the `/maps` handler's try (or bounds-check lumps in `bsp.ts`) (bug 8).
5. Guard `texture-export.ts` CLI behind `require.main === module` (bug 6).
6. Key the WAL palette cache by path (bug 5); clear stale `players` on empty frames (bug 7).
7. Make `BufferReader.readBytes` throw on under-read; clear the tick timer in
   `MvdDemoReader.playBuffer` (bugs 4, 9).
8. Add a diagnostics hook for unknown MVD/svc opcodes in `frame.ts`.
9. Sync docs: remove `deflate` and `example.ts` from README, fix AGENTS.md/testing.md lists.
10. Add tests for `bsp.ts`/`wal.ts`/`map-render.ts` and the `/maps` endpoint; cover reconnect
    logic in `client.test.ts`.
11. Remove dead code (unused `lines`, wal noop, duplicated stream-start, grid opacity ternary);
    consider event-emitter callbacks on `MvdFrameParser` to replace handler chaining.
12. Optional features observed missing: `GTF_DEFLATE` support, demo pause/seek, `?markers` query
    for entity markers, SSE heartbeat, pak overlay cleanup on exit.
