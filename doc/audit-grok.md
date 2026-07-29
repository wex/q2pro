# ts-mvd project audit (Grok)

Date: 2026-07-30.
Scope: everything under `ts-mvd/` (source, tests, browser client, configs).
Method: full source read-through of `src/` + `public/`, cross-check of protocol
constants and TE layouts against `inc/server/mvd/protocol.h`,
`inc/shared/shared.h`, and `src/client/parse.c`, plus a verification run.
Complements `doc/audit.md` (2026-07-29); that audit’s bugs 1–9 remain fixed.
This report focuses on **remaining open items and newly identified issues**.

## Verification snapshot

- `npm run build` — passes (`tsc`, no errors).
- `npm test` — 9 suites, 97 tests, all pass (with `forceExit`, as configured;
  Jest still warns about open handles from `app` import side effects).
- Protocol constants spot-checked against the C reference: `GTV_PROTOCOL_VERSION`
  (`0xED04`), `MAX_GTS_MSGLEN` (`0x8000`), GTV opcodes/flags, `MvdOp` ordering —
  all match.
- `doc/audit.md` verification snapshot (“7 suites / 69 tests”) is stale relative
  to the current suite count.

## Prior audit status (spot-check)

| Prior item | Status |
|------------|--------|
| Reconnect backoff / soft vs fatal errors | Still fixed |
| Manual `disconnect()` emits `close` | Still fixed |
| Demo re-play tick timer clear | Still fixed |
| Palette cache keyed by path | Still fixed |
| `texture-export` CLI `process.exit` guard | Still fixed |
| Empty-frame `players.clear()` | Still fixed |
| BSP lump extent validation + `/maps` try/catch | Still fixed |
| `readBytes` throws on under-read | Still fixed |
| Replay path traversal confined to `DEMOS_DIR` | Still fixed |
| GTV password from Connect UI / body | Still fixed |
| SPA extension 404s | Still fixed |
| Unknown MVD opcode → `onParseWarning` | Still fixed |
| `/connect` TOCTOU | Still open |
| Pak overlay never removed | Still open |
| SSE hygiene / backpressure | Still open |
| `GTF_DEFLATE` unsupported | Still open (documented) |
| Map-pipeline tests | Still open |
| EventEmitter refactor on `MvdFrameParser` | Still open |

---

## Bugs / correctness

### 1. High — Auto-reconnect races with demo replay
**Where:** `src/app.ts` `startReplay` / `POST /replay`; `src/client.ts`
`scheduleReconnect`

`POST /replay` only requires `client.state === Disconnected`. Soft-close already
sets that state while a `reconnectTimer` is still pending. Starting a replay
does **not** call `client.disconnect()` (which would cancel the timer). When
the timer fires, `connect()` starts live GTV during replay and both pipelines
feed the same parser.

**Fix:** Cancel reconnect on replay start (`client.disconnect()` or a dedicated
`cancelReconnect()`). Expose `reconnecting` in `GET /state`. Reject live connect
while a replay is active inside client/app callbacks as well as HTTP.

### 2. High — Soft disconnect treated as session end (Connect modal reopen)
**Where:** `src/app.ts` `client.on('close')` → `sseBroadcast('liveStop')`;
`public/app.js` `liveStop` → `refreshSessionState({ reopen: true })`

Every soft-close/auto-reconnect emits `close` → `liveStop`. `/state` reports
`mode: 'idle'` while reconnect is scheduled, so the UI reopens the Connect
modal mid-backoff. Users can then start replay or a second connect (feeds #1).

**Fix:** Distinguish user disconnect vs soft-close vs “reconnecting”; only emit
`liveStop` / reopen the modal on fatal or user disconnect; add `reconnecting`
to `/state`.

### 3. Medium — Stale pipeline state after live close / replay end
**Where:** `src/app.ts` `close` handler; `stopReplay` / replay `end`; contrast
`resetPipelineState`

`resetPipelineState()` runs on replay *start* and map `serverdata`, but **not**
on user disconnect, soft-close, or replay end. SSE snapshots keep old `players`,
`chatLog`, `killFeed`, and `scoreboard`.

**Fix:** Call `resetPipelineState()` (and broadcast a cleared snapshot) on user
disconnect and optionally on replay end; decide whether soft-reconnect should
preserve or flush.

### 4. Medium — Incomplete inner `svc_*` walker aborts mid-payload
**Where:** `src/frame.ts` `parseInnerSvcMessages`

Only handles Nop, Print, Layout, CenterPrint, TempEntity, MuzzleFlash(2),
StuffText. Common ops such as `SvcOp.Sound` (9), Inventory, ConfigString, etc.
hit `default` and **abort the rest of that unicast/multicast payload**. Outer
`MvdOp.Sound` is skipped; in-band `svc_sound` is not. Trailing TE/muzzleflash
ops in the same payload are dropped.

**Fix:** Add skip parsers for `svc_sound` (flags + optional fields) and other
fixed/skippable ops; keep abort only for truly unknown lengths.

### 5. Medium — Many TE types not consumable (incl. AQ2 `TE_DAMAGE_DEALT`)
**Where:** `src/frame.ts` `parseTempEntity`; `src/protocol.ts` `TempEntityType`

Only a subset of TE layouts are walked. Unknown types warn and return `false`,
stopping the inner walker. Missing layouts include cable/beam TEs already
enumerated (`ParasiteAtk`, `GrappleCable`, `MedicCableAtk`, …) and AQ2
`TE_DAMAGE_DEALT = 128` (`[int16]` only) from `inc/shared/shared.h` /
`src/client/parse.c` / `src/action/p_view.c`. Hit-marker unicasts and
Rogue/Xatrix-style TEs can abort further ops in the same payload.

**Fix:** Port skip sizes from `CL_ParseTEnt` in `src/client/parse.c`; at least
skip `TE_DAMAGE_DEALT` (read short and continue) and the cable TE layouts
already present in the enum.

### 6. Medium — Exported `startReplay` can leak a prior demo timer
**Where:** `src/app.ts` `startReplay`

HTTP returns 409 if a replay is active, but the exported function overwrites
`currentReplay` without `stop()` on the previous reader. Orphaned `setInterval`
if tests/embedders call `startReplay` twice.

**Fix:** Call `stopReplay()` / stop the previous reader at the top of
`startReplay`.

### 7. Medium — Browser `loadMap` race (stale map / revoked blob)
**Where:** `public/app.js` `loadMap` / `runRaster`

No generation token. Concurrent `loadMap` (texture toggle + map change) can
revoke the newer blob URL or apply an older SVG. If `rasterInFlight`,
`loadMap`’s `await runRaster()` can return without producing a bitmap.

**Fix:** Monotonic `mapLoadGen`; ignore/abort stale completions; queue or cancel
in-flight raster on map change.

### 8. Low — Combat FX attributes to any `inUse` player
**Where:** `src/combat-fx.ts` `findNearestPlayer`

No alive/health/spectator filter; corpses still `inUse` can win nearest-player
attribution for blood/sparks TEs.

**Fix:** Skip dead / spectator slots when resolving the victim.

### 9. Low — Uncaught `JSON.parse` on most SSE handlers
**Where:** `public/app.js` SSE listeners

Most listeners call `JSON.parse(e.data)` without try/catch (`replayError` is the
exception). A bad event throws out of the listener and skips that update.

**Fix:** Wrap each handler; log and return on parse failure.

---

## Security / robustness

### 10. High — Path traversal via BSP/pak texture names into overlay
**Where:** `src/app.ts` `materializeFromPak` / `prepareTexturesDir`;
`src/pak.ts` `normalizeName`; `src/wal.ts` `loadWalTexture`

Overlay paths are `path.join(PAK_OVERLAY_DIR, norm)` / `path.join(overlayTex,
name + '.wal')` with no confinement check. `normalizeName` does not strip `..`.
A crafted BSP texinfo name or pak entry like `../../evil` can write or read
outside the temp overlay under the Node process user.

**Fix:** Reject `..`, NUL, and absolute segments; after `path.resolve`, require
`resolved === overlayRoot || resolved.startsWith(overlayRoot + sep)`. Refuse
pak entry names with `..` at index time. Apply the same check in
`loadWalTexture`.

### 11. High — ZIP bomb / unbounded inflate and `Buffer.alloc`
**Where:** `src/pak.ts` `PakIndex.read` and directory parsers

No check that `offset + compressedSize ≤ archive size`, no cap on
`compressedSize` / `uncompressedSize`, and `zlib.inflateRawSync` ignores
declared size. A malicious `.pkz`/`.pak` can OOM or stall the process on the
first `/maps/...` that pulls that entry.

**Fix:** Validate extents at index/read time; use
`zlib.inflateRawSync(buf, { maxOutputLength: … })` with a global ceiling
(e.g. 32–64 MiB); reject absurd sizes before `Buffer.alloc`.

### 12. Medium — Pak overlay dir + archive FDs never cleaned up
**Where:** `src/app.ts` `PAK_OVERLAY_DIR` / SIGINT; `src/pak.ts` `close`

Temp overlay is created at import and never `rmSync`’d on shutdown.
`pakIndex.close()` is never called. Matches the open item in `doc/audit.md`.

**Fix:** On SIGINT / exit: `pakIndex.close()` and
`fs.rmSync(PAK_OVERLAY_DIR, { recursive: true, force: true })`.

### 13. Medium — BSP face/edge/vertex indices not validated
**Where:** `src/bsp.ts` `getFacePolygon` / `getFaceNormal`;
`src/map-render.ts` `processFaces`

Header lump bounds are checked, but face → surfedge → edge → vertex and
`planenum` are not. Bad chains yield `undefined`/NaN paths or throws (caught by
`/maps` try/catch); large `numedges` can still burn CPU/memory.

**Fix:** Bounds-check every index; skip invalid faces; optionally cap
`numedges` / total polys.

### 14. Medium — Unbounded WAL dimensions / SVG embedding DoS
**Where:** `src/wal.ts` `parseWal` / `rgbaToPngDataUrl`;
`src/map-render.ts` `generateMapSvg`

No max on WAL `width`/`height`. Unique textures are PNG-encoded and inlined as
base64 data URLs in one SVG. Huge world bounds also inflate SVG pixel size.
All runs synchronously on the HTTP thread.

**Fix:** Cap WAL size and world/SVG pixel dimensions; consider external texture
refs or a size budget; optionally cache SVG / move render off the request path.

### 15. Medium — Silent swallow of inner parse errors
**Where:** `src/frame.ts` `parseUnicast` / `parseMulticast` empty `catch`

All exceptions discarded with no `onParseWarning` / counter bump. Corrupt
payloads fail quietly.

**Fix:** Report via `onParseWarning` (e.g. `inner_parse_error`) before return.

### 16. Medium — Module import side effects (UDP + HTTP + temp dir)
**Where:** top level of `src/app.ts`

Importing for tests creates a UDP socket, indexes paks, and makes a temp dir;
only `forceExit` hides the leak (Jest open-handles warning).

**Fix:** Lazy-init behind `createApp()` / `require.main` bootstrap.

### 17. Low — `/connect` TOCTOU (prior open)
**Where:** `src/app.ts` `/connect`

Check-then-act on `client.state` / `currentReplay` without serialization.
Concurrent POSTs can both pass.

**Fix:** Mutex / single-flight around session transitions.

### 18. Low — SSE write without backpressure (prior open)
**Where:** `src/app.ts` `sseBroadcast`

`res.write` return value ignored; slow clients buffer unbounded frame traffic.

**Fix:** Drop/skip clients when `write` returns false; optional heartbeat.

### 19. Low — Unbounded `recvBuf` concat / outbound size not capped
**Where:** `src/client.ts` `onTcpData` / `sendMessage`; `src/protocol.ts`
`MAX_GTC_MSGLEN`

Hostile peer can grow receive memory until oversize/soft-close. Outbound hello /
stringcmd do not enforce `MAX_GTC_MSGLEN` (256).

**Fix:** Cap total buffered bytes; enforce max length before write.

### 20. Low — Absolute demo paths leaked in SSE / `/state`
**Where:** `src/app.ts` `replayStart`, `currentReplayFile` in `/state`

Leaks server filesystem layout; HTTP `/replay` response correctly uses basename.

**Fix:** Always expose basename (or a relative path under `DEMOS_DIR`).

### 21. Low — Latent XSS pattern in `loadoutIconHtml` `onerror`
**Where:** `public/app.js` `loadoutIconHtml`

`escapeHtml` is wrong inside a JS string in an HTML attribute: `&quot;` /
`&#39;` decode back to `"` / `'` and can break out of the `outerHTML='...'`
string. Today labels come from fixed `WEAPON_ICON`/`ITEM_ICON` keys, so
practical risk is low.

**Fix:** Drop inline `onerror` HTML; use event delegation or a safe text
fallback without string-built JS.

### 22. Low — `bspCache` unbounded growth
**Where:** `src/app.ts` `loadBsp`

Every distinct map name that resolves stays in memory for the process lifetime.

**Fix:** LRU with a small cap, or clear on idle.

### 23. Low — Incomplete BSP header length check edge case
**Where:** `src/bsp.ts` `BspFile.load`

Buffers shorter than 8 bytes throw a raw `RangeError` before the friendly
“truncated” path.

**Fix:** Check `buf.length < 8 + HEADER_LUMPS * 8` first.

### 24. Low — Demo files fully slurped into memory
**Where:** `src/demo.ts` `play`

Huge `.mvd2` → large heap. A streamed reader would be safer for long recordings.

---

## Parser / protocol gaps (known / residual)

| Item | Notes |
|------|--------|
| `GTF_DEFLATE` unsupported | Still open; README documents the limitation |
| Chat dedup can swallow legitimate duplicates | Documented trade-off (`doc/chat-dedup.md`) |
| `onParseWarning` unused in `app.ts` | Parser can drop bytes; app never logs counts |
| Cable/beam TE + `TE_DAMAGE_DEALT` skip | See bugs #4–#5 |
| `BufferReader` primitives rely on Node `RangeError` | `readBytes` is strict (good); optional `ensure(n)` |
| `readString` without NUL reads to EOF | Possible desync in corrupt streams |

---

## Dead / redundant / UI clutter

- `scoreboardState.layoutText` / `layoutsFlags` are written from SSE but never
  rendered in `public/app.js`.
- `serverStatus` is mainly used to pull `maxclients`.
- `onFrame` callback chaining in `app.ts` still fragile (EventEmitter refactor
  deferred — prior open).
- `public/app.js` TS migration — still open / long-term (`doc/audit.md`).

---

## Documentation drift

- `doc/audit.md` verification numbers (7 suites / 69 tests) vs current
  9 / 97.
- Otherwise README / AGENTS / feature docs look aligned with prior audit fixes
  (password, replay confinement, no false `deflate` claim).

---

## Test coverage gaps

Risky paths with little or no coverage:

1. Reconnect timer + `POST /replay` / `POST /connect` interleaving.
2. `liveStop` / `/state` while reconnect pending (modal reopen).
3. Inner `svc_sound` / `TE_DAMAGE_DEALT` / multi-op multicast before TE.
4. Hostile pak/BSP `../` texture names and zip-bomb size caps.
5. Stale snapshot after `/disconnect` and replay `end`.
6. Double `startReplay()` via exported API.
7. Successful `/maps` render, pak overlay materialize, WAL bounds.
8. `wal` / `map-render` / `texture-export` — still no dedicated suites.
9. SSE heartbeat / backpressure behaviour.

---

## What looks solid

- Replay path traversal confined (`basename` + `DEMOS_DIR`); covered by tests.
- Map route name regex `^\/maps\/([\w.-]+)$` blocks `/` traversal on map names.
- Chat / killfeed / scoreboard names use `escapeHtml` / `textContent`.
- SVG texture names use `escapeXml` in titles / map label.
- Static file serving confined under `PUBLIC_DIR`.
- Soft vs fatal GTV error reconnect policy and backoff escalation.
- BSP header lump extent validation (with the short-buffer edge case noted above).

---

## Prioritized TODO list

1. Cancel reconnect on replay; expose reconnecting state; don’t reopen Connect
   modal on soft-close (#1, #2).
2. Confine pak/BSP overlay paths; reject `..` names (#10).
3. Cap pak inflate/alloc + archive extent checks (#11).
4. Skip `svc_sound` + common TE layouts, especially `TE_DAMAGE_DEALT` (#4, #5).
5. Reset or explicitly clear pipeline on user stop / replay end (#3).
6. Delete pak overlay + `pakIndex.close()` on shutdown (#12).
7. BSP index validation + WAL/SVG size caps (#13, #14).
8. Wire `onParseWarning` in `app.ts`; stop silent inner `catch` (#15, #16).
9. Browser: `loadMap` generation token + SSE `JSON.parse` guards (#7, #9).
10. Tests for session races, hostile assets, and map-pipeline happy path.
11. Optional follow-ups: `GTF_DEFLATE`, SSE heartbeat/backpressure, EventEmitter
    on `MvdFrameParser`, `/connect` mutex, demo pause/seek.
