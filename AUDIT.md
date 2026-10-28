# ts-mvd code audit

Date: 2026-10-28.
Scope: everything under `ts-mvd/` (source, tests, browser client).
Method: full source read-through, cross-check of wire parsing against the C reference
(`src/common/msg.c`, `src/server/mvd/parse.c`, `src/client/parse.c`, `inc/shared/shared.h`),
plus empirical probes against the bundled `assets/demos/demo.mvd2`.

Supersedes / extends `doc/audit.md` (2026-07-29). All items marked FIXED there were
re-verified as fixed.

## Verification snapshot

- `npx tsc --noEmit -p tsconfig.test.json` — passes.
- `npx jest` — 9 suites, 97 tests, all pass (with `forceExit`, as configured).
- Wire format in `frame.ts` matches the C reference exactly: PPS/U_ bit layout, read order of
  `MSG_ParseDeltaPlayerstate_Packet`, `MSG_ReadDeltaInt23`, ext2 coords, fog/blend skipping,
  `MVD_ParseSound`, unicast/multicast `length |= extrabits << 8` framing, serverdata flag
  handling (`EXTLIMITS2` reads a u16 flags word).
- Configstring constants match `inc/shared/shared.h`:
  OLD layout `MODELS=32 SOUNDS=288 IMAGES=544 LIGHTS=800 ITEMS=1056 PLAYERSKINS=1312 GENERAL=1568 END=2080`;
  EXT layout `MODELS=62 SOUNDS=8254 IMAGES=10302 LIGHTS=12350 ITEMS=12606 PLAYERSKINS=12862 GENERAL=13118 END=13630`.
- `/maps/urban` render timing: BSP load 9 ms, textured SVG 56 ms (0.6 MiB), plain SVG 6 ms (228 KiB).
  No SVG caching needed.

## Confirmed bugs

### 1. Configstring layout "try EXT then OLD" is wrong on vanilla-layout streams — FIXED (fix/cs-layout-selection)
Files: `src/player-loadout.ts` (`lookupModel`), `src/app.ts` (`parser.onConfigString`
disconnect pruning), `public/app.js` (`recomputeMaxclients`).

The bundled demo is `version 2010, flags 0` → vanilla layout. `CS_MODELS_EXT=62` and
`CS_MAXCLIENTS_EXT=60` fall *inside* the vanilla `CS_MODELS` range (32..288), so the EXT probe
hits a real model string and the `||` fallback never runs. Probe output:

```
cs30 = "20"
cs60 = "models/items/armor/jacket/tris.md2"   → parseInt(cs60 ?? cs30) = NaN
gun 4: ext-lookup "#w_super90.md2" | old-lookup "models/weapons/v_blast/tris.md2"
```

Consequences:
- `app.ts` lines ~308–313: `maxclients` is `NaN`; `Math.max(NaN, 256)` is `NaN`; the
  `ev.index < base + NaN` test is always false. **Scoreboard entries are never pruned on player
  disconnect** for any vanilla-layout server. The existing regression test passes only because
  its fixture has no cs 60. Identical logic (and bug) in `public/app.js` `recomputeMaxclients`.
- `player-loadout.ts` `lookupModel` returns the wrong configstring, so the gunindex → weapon
  path is effectively dead on vanilla layout (silently degrades to the ammo-icon heuristic).

Fix: `MvdFrameParser` already computes `this.extended`; expose it on `ServerDataEvent`
(e.g. `extended: boolean`) and have app/loadout pick exactly one base set instead of probing.
`CS_ITEMS_EXT` / `CS_IMAGES_EXT` / `CS_PLAYERSKINS_EXT` are > 2080 so they are safe today, but
the same explicit selection should be applied for consistency.

### 2. `svc_sound` inside unicast/multicast payloads aborts the inner walk — FIXED (fix/inner-svc-ops)
File: `src/frame.ts` (`parseInnerSvcMessages` default branch).

7 × `unknown_svc_op opcode: 9` warnings in the 42-second demo. The parser stops walking the
rest of the payload, so any `svc_temp_entity` / `svc_muzzleflash` / `svc_print` after the
sound in the same multicast is lost. The format is fully determinable from
`CL_ParseStartSoundPacket`: `flags u8`, `index u8|u16 (SND_INDEX16 && extended)`,
`SND_VOLUME→u8`, `SND_ATTENUATION→u8`, `SND_OFFSET→u8`, `SND_ENT→u16`, `SND_POS→pos`.
Add a `skipInnerSound()` mirroring `skipSound()`.

## Robustness / design

3. **Unhandled `'error'` emitter semantics — `src/client.ts` — FIXED (fix/error-event-guard).**
   `MvdClient` emits `'error'` on a Node `EventEmitter`; a library consumer who does not
   subscribe gets a process crash on a TCP error. `emitError()` now emits only when a listener
   is attached (README updated).
4. **Duplicate code — `src/client.ts` — FIXED (fix/client-close-dedup).** `onTcpClose()`
   delegates to `softClose()`; the `GtvServerOp.Reconnect` branch reuses it too, and
   `sendStreamStart()` no longer forces a bogus `Ready` state while disconnected.
5. **SSE write hygiene — `src/app.ts` — FIXED (fix/sse-hygiene).** `sseWrite()` ends clients
   buffered past 1 MiB, a 25 s unref'd heartbeat emits `:hb` comments, and `error` removes
   clients from the set.
6. **Network exposure — `src/app.ts`.** `httpServer.listen(HTTP_PORT)` binds all interfaces
   with no auth; `POST /connect` makes the server open TCP to any host:port and
   `sendOOBStatus` sends UDP there. Default to `127.0.0.1` with an `HTTP_HOST` override. UDP
   status replies are not matched against `host:port` (spoofable).
7. **`/connect` TOCTOU.** State is checked before `await readJsonBody`; two concurrent POSTs can
   both pass; the second `connect()` is a silent no-op while still returning 202.
8. **Minor.**
   - `BufferReader.readString` decodes `ascii`, which masks the high bit — accidental; it
     strips Q2 "green text" before `classifyChat` runs. `latin1` would preserve it for an
     explicit strip step. `BufferWriter.writeString` has the same limitation (non-ASCII
     passwords).
   - `pak.ts` `read()` does not validate `offset + compressedSize <= archive.size` nor the
     `readSync` byte count.
   - `PAK_OVERLAY_DIR` is never removed (open since previous audit).
   - `[configstring N]` is logged on every update — noisy on busy servers.
   - Three chained `parser.onFrame` wrappers in `app.ts` are hard to follow (EventEmitter
     refactor still pending).
   - `MvdClient.sendStreamStart()` is public and sets state `Ready` even when disconnected.

## Test gaps

- A fixture with a populated vanilla `CS_MODELS` range (would have caught bug 1).
- `svc_sound` followed by `svc_temp_entity` in one multicast payload (bug 2).
- No coverage for `wal.ts`, `map-render.ts`, `texture-export.ts`, or the `/maps` happy path
  (render is ~6–56 ms, so a snapshot test is cheap).
- `demo.ts` realtime pacing is untested. Pacing is 1 message per tick; the bundled demo is
  exactly 1 frame per message (419/419), so this is correct today.

## Feature suggestions

1. **Demo pause / seek / speed** — `MvdDemoReader` already holds all messages in memory;
   `pause()`, `seek(frame)` (replay from last serverdata) and a `speed` multiplier are small
   and would make a browser scrubber trivial.
2. **Sound events** — once bug 2 is fixed, surface `onSound` (index → `CS_SOUNDS` name) so the
   UI can show footsteps / reloads / grenade bounces on the map.
3. **Per-round stats** — `onDeath` + `HitEvent` + `ObituaryEvent` suffice to compute K/D,
   accuracy-by-location and a round timeline server-side; expose via `GET /stats` and SSE.
4. **GTF_DEFLATE** — the one GTV capability still missing; `zlib.inflateSync` per message once
   the 2-byte length framing is kept outside the compressed region.
5. **Multi-stream** — `app.ts` is a singleton (one `client`, one `parser`). A `Session` class
   wrapping the pipeline enables following several servers from one UI and removes the
   `onFrame` chaining.
6. **Record live to `.mvd2`** — the client receives exactly the bytes a demo contains; writing
   `MVD2` + `[u16 len][payload]` to disk is ~20 lines and gives replays of live sessions.
7. **Migrate `public/app.js` to TypeScript** — 1.5k lines duplicating constants from
   `player-loadout.ts` / `protocol.ts` (and already duplicating bug 1).

## Prioritized TODO

1. ~~Fix bug 1 (expose layout from parser; single base-set lookup in app/loadout/app.js) + tests~~ done.
2. ~~Fix bug 2 (`skipInnerSound`) + test~~ done (also inner `svc_configstring`).
3. ~~Deduplicate `onTcpClose` / `softClose` / `Reconnect` in `client.ts`~~ done.
4. ~~SSE backpressure + heartbeat~~ done; bind HTTP to localhost by default — open.
5. Map-pipeline tests (`wal` / `map-render` / `/maps`) — open follow-up.
6. Features 1, 2, 6 (small); 4, 5, 7 (larger) — open.
