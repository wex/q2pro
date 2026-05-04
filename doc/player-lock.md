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

When the locked player disconnects or is absent from a frame, the camera holds its last position — no crash, no auto-unlock.  The lock resumes tracking if the player reappears (e.g. after a brief `PPS_REMOVE` window around respawn).

## Implementation

### State

```js
let lockedPlayerNum = null;   // null = free camera; integer = locked client slot
let dragStart = null;          // { x, y } CSS px, set on mousedown for travel detection
```

### Helpers (`public/app.js`)

- **`cssToSvg(cx, cy)`** — converts CSS pixel coordinates to SVG space using the current transform.
- **`hitTestPlayer(cx, cy)`** — iterates `players`, returns the first entity whose SVG-space circle (radius 16) contains the point.
- **`applyLockCamera()`** — if `lockedPlayerNum` is set, re-centres `transform.tx`/`ty` on the locked player's current SVG position.

### Render integration

`applyLockCamera()` is called at the top of `renderFrame()`, before `renderMap()` and `renderPlayers()`.  Because SSE `frame` events call `scheduleRender(PLAYERS_DIRTY)`, the camera tracks the player at the server's delivery cadence without any extra timers.

### Click vs. drag detection

`mousedown` records `dragStart`.  `mousemove` unlocks and clears the lock if squared travel > 16 (4 px).  `mouseup` checks the same threshold: if it was a tap (≤ 4 px travel) it runs `hitTestPlayer` and updates `lockedPlayerNum`.

### Visual feedback

A thin white ring (`rgba(255,255,255,0.85)`, 2 px, radius `r + 6`) is drawn behind the locked player's circle on every `renderPlayers` call.  The ring scales with `transform.scale` so it stays visually consistent at any zoom level.

## Files changed

| File | Change |
|------|--------|
| `ts-mvd/public/app.js` | `lockedPlayerNum` + `dragStart` state; `cssToSvg`, `hitTestPlayer`, `applyLockCamera` functions; `applyLockCamera()` call in `renderFrame`; lock ring in `renderPlayers`; updated `mousedown` / `mousemove` / `mouseup` / `dblclick` handlers |
