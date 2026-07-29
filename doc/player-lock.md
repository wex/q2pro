# Player Camera Lock

Click a player icon on the map to lock the camera to that player; the view re-centres on every frame update until the lock is released.

## Behaviour

| Action | Result |
|--------|--------|
| Click a player icon | Camera locks to that player (white ring drawn around icon) |
| Click a different player | Lock switches to the new player |
| Click empty map space | Camera unlocks |
| Drag / pan (> 4 px travel) | Camera unlocks immediately |
| Double-click | Camera unlocks + fits map to screen |
| Click scoreboard row | Toggle lock on that client slot |

When the locked player disconnects or is absent from a frame, the camera holds its last position — no crash, no auto-unlock.  The lock resumes tracking if the player reappears (e.g. after a brief `PPS_REMOVE` window around respawn).

While following, pan is **clamped to the viewport** so the map never scrolls off-window; near map edges the player sits off-centre rather than exposing empty void.

### Follow-mode panel

While `lockedPlayerNum` is set, the side panel enters **follow mode** (`#panel.follow-mode`):

| Lock state | Scoreboard | Kill feed + chat |
|------------|------------|------------------|
| Unlocked | Full roster | Visible |
| Locked + target **alive** | Only that player's row | Hidden |
| Locked + target **dead** | Full roster (locked row highlighted) | Hidden |

Alive uses the same live/sticky loadout signals as the scoreboard. Kill feed and chat keep receiving events while hidden; unlocking restores the sections with the backlog intact. Death does not unlock the camera.

## Implementation

### State

```js
let lockedPlayerNum = null;   // null = free camera; integer = locked client slot
let dragStart = null;          // { x, y } CSS px, set on mousedown for travel detection
```

### Helpers (`public/app.js`)

- **`cssToSvg(cx, cy)`** — converts CSS pixel coordinates to SVG space using the current transform.
- **`hitTestPlayer(cx, cy)`** — iterates `players`, returns the first entity whose SVG-space circle (radius 16) contains the point.
- **`applyLockCamera()`** — if `lockedPlayerNum` is set, re-centres `transform.tx`/`ty` on the locked player's current SVG position, then `clampTransformToViewport`.
- **`clampTransformToViewport(t)`** — clamps pan so the scaled map stays inside the browser window.
- **`setLock(num)`** — updates lock, follow-mode class, and re-renders the scoreboard.
- **`isFollowTargetAlive()`** — live or sticky `alive` for the locked slot.
- **`updateFollowUi()`** — toggles `#panel.follow-mode` while locked.

### Render integration

`applyLockCamera()` is called at the top of `renderFrame()`, before `renderMap()` and `renderPlayers()`.  Because SSE `frame` events call `scheduleRender(PLAYERS_DIRTY)`, the camera tracks the player at the server's delivery cadence without any extra timers.

`renderScoreboard()` filters to the locked row when `isFollowTargetAlive()`, and calls `updateFollowUi()` so death/respawn flips single-row vs full board without unlocking.

### Click vs. drag detection

`mousedown` records `dragStart`.  `mousemove` unlocks and clears the lock if squared travel > 16 (4 px).  `mouseup` checks the same threshold: if it was a tap (≤ 4 px travel) it runs `hitTestPlayer` and updates `lockedPlayerNum`.

### Visual feedback

A thin white ring (`rgba(255,255,255,0.85)`, 2 px, radius `r + 6`) is drawn behind the locked player's circle on every `renderPlayers` call.  The ring scales with `transform.scale` so it stays visually consistent at any zoom level.

## Files changed

| File | Change |
|------|--------|
| `ts-mvd/public/app.js` | Lock helpers, follow-mode scoreboard filter / panel class, `clampTransformToViewport` |
| `ts-mvd/public/app.css` | `#panel.follow-mode` hides kill feed + chat |

## Related

- [player-loadout.md](player-loadout.md) — alive / sticky loadout signals used by follow-mode scoreboard filtering.
