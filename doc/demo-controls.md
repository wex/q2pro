# Demo playback controls — pause / seek / speed

`MvdDemoReader` now exposes playback controls on top of the in-memory message
list, and the HTTP surface + browser UI expose them to replay sessions.

## Library API (`src/demo.ts`)

| Member | Behaviour |
|---|---|
| `pause()` / `resume()` | Gate the realtime timer without losing `position`. Emits `pause`/`resume`. No-op when finished or non-started. |
| `seek(targetIndex)` | Moves the cursor **back to the nearest keyframe ≤ target** — a message whose first opcode is `mvd_serverdata` or `mvd_framenodelta` (detected at decode time). Emits `seek` with the snapped index, then re-emits `[keyframe, target)` as **silent catch-up** (`catchup=true` on `message`), emits `seeked` with the final cursor, and returns the snapped index. Runs while paused too. |
| `setSpeed(m)` | Scales the realtime tick (`tickMs / m`), clamped to `[0.25, 8]`. Takes effect on the next scheduled tick. |
| `position`, `messageCount`, `paused`, `speed` | Read-only state getters for progress display. |

**Why snap to keyframes?** MVD frames are delta-compressed against prior
player/entity state; feeding the parser a mid-stream frame without its
baseline produces garbage. The snapped keyframe restores a full baseline —
consumers must reset parser state on the `seek` event (the app calls
`resetPipelineState()`).

**Silent catch-up.** Before this change a seek only moved the cursor to the
keyframe and realtime replayed the gap at normal speed — scrubbing mid-demo
took as long as the gap itself. Now the reader re-emits the whole
`[keyframe, target)` span synchronously with `catchup=true`, so the parser
rebuilds delta state at the requested position instantly. Listeners must
still feed those messages to `MvdFrameParser` but should suppress outward
broadcasts — `Session` gates `broadcast` on a `silentCatchup` flag while
parsing them, so SSE clients see one `replayState` on `seeked` instead of a
frame/print/configstring storm. Realtime playback then resumes from the
target.

**Frame-boundary pacing.** Realtime ticks used to emit exactly one message
per `tickMs` — correct only for demos storing exactly one `mvd_frame` per
message. The tick now bursts every message up to and including the next
message whose first op is `mvd_frame`, so frame-less runs (configstring
bursts, unicast batches) and messages packing several frames keep the
intended 10 Hz cadence. The heuristic checks the first byte only; a frame
op mid-message rides with its batch's tick (AUDIT-2 item 14).

After a natural `end` the message buffer is retained specifically so seeking
backward works; `stop()` remains the teardown that drops it.

## HTTP surface

- `POST /replay/control` — JSON body `{pause?: boolean, speed?: number,
  seek?: number}` applied in that order.
  - `202` with the resulting replay state `{file, paused, speed, position,
    messageCount}` (also broadcast as the `replayState` SSE event).
  - `409 {error:'no-replay'}` when no replay is active (checked again after
    the async body read).
  - `400 {error:'invalid-pause'|'invalid-seek'|'invalid-speed'}` for bad
    values (`seek` must be a non-negative integer; `speed` must be finite
    and > 0 — the server clamps into [0.25, 8]).
- `GET /state` and the `/events` snapshot now carry a `replay` object with
  the same payload (`null` when no replay is active).

## Browser UI

A minimal control bar appears in the top status pill while a replay is
active: Pause/Resume button, a seek slider, and a speed select
(0.5/1/2/4×). Since one MVD message ≈ one server frame, the slider advances
locally between sparse `replayState` broadcasts — an approximation that can
drift a few ticks on streams with extra unicast messages.

## Tests

`demo.test.ts` covers frame-burst pacing, pause/resume, keyframe snapping,
silent catch-up flagging + `seeked`, paused seeks rebuilding without
resuming, seeking after `end`, speed scaling/clamping, and non-realtime
seek drain. `session.test.ts` pins broadcast suppression during catch-up.
`app.test.ts` covers the control route's 409/400/202 paths and `/state`
round-tripping.
