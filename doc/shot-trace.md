# Shot Trace Visualization

Short-lived lines drawn on the 2D map view from a shooter's origin to an
impact point. The server resolves a `shooter` client number for each
temp-entity (TE) shot event; the client owns all rendering, styling and
fading.

## Scope

Visualized TE types:

| Type            | Id  | Wire frame        | Shooter resolution             |
|-----------------|-----|-------------------|--------------------------------|
| `RailTrail`     | 3   | `position`, `endPosition` | Nearest player to muzzle |
| `BubbleTrail`   | 11  | `position`, `endPosition` | Nearest player to muzzle |
| `BfgLaser`      | 23  | `position`, `endPosition` | Nearest player to muzzle |
| `BlueHyper`     | 27  | `position`, `endPosition` | Nearest player to muzzle |
| `Gunshot`       | 0   | `position` (impact) only  | Recent hit-event attacker |
| `Shotgun`       | 4   | `position` (impact) only  | Recent hit-event attacker |
| `Sparks`        | 9   | `position` (impact) only  | Recent hit-event attacker |
| `BulletSparks`  | 14  | `position` (impact) only  | Recent hit-event attacker |

Blood, explosions, and all other TE types are not forwarded.

## Architecture

```
MVD stream ──► frame.ts (parseTempEntity) ──► onTempEntity
                                                  │
                                                  ▼
                                         ShotTraceResolver
                                             │        ▲
                         hit events ─────────┘        │
                         frame players ────────────── ┘
                                                  │
                                                  ▼
                                         SSE event: 'shot'
                                                  │
                                                  ▼
                                         public/app.js (handleShot)
                                                  │
                                                  ▼
                                         renderPlayers() traces loop
```

- `ts-mvd/src/shot-trace.ts` is a **pure module** (no I/O, no SSE
  dependency) exposing `ShotTraceResolver`. Unit tests in
  `ts-mvd/test/shot-trace.test.ts`.
- `ts-mvd/src/app.ts` instantiates the resolver, feeds it `noteHit`,
  `notePlayers`, and the raw `TempEntityEvent`, and broadcasts the
  resulting `ShotEvent` over SSE.
- `ts-mvd/public/app.js` subscribes to `shot`, builds trace segments,
  and fades them in `renderPlayers`.

## Wire contract

SSE event `shot` payload:

```ts
interface ShotEvent {
  type: number;                       // TempEntityType
  wireStart: [number, number, number]; // muzzle (two-point) or impact (single-point)
  wireEnd?: [number, number, number];  // impact (two-point only)
  shooter?: number;                    // resolved clientNum, if known
  t: number;                           // server timestamp (ms)
}
```

Note: the previous raw `te` SSE event has been removed.

## Resolution rules

### Two-point TEs

`shooter` = live player whose origin is nearest to `wireStart` (the
muzzle), within `muzzleMaxDist` (default 4000 world units). If every
candidate is beyond the cap, `shooter` is left undefined and the event
is still emitted so the client may render the raw line.

### Single-point bullet TEs

`shooter` = most recent `noteHit(attacker, t)` entry within
`hitWindowMs` (default 250 ms). If the window is empty, `shooter` is
undefined and the client drops the event (no line drawn).

This path deliberately does **not** do geometric inference: unbound
single-point TEs never produce a line.

## Tuning constants

Pass these to `new ShotTraceResolver({ ... })`:

- `muzzleMaxDist` — nearest-player distance cap for two-point TEs.
- `hitWindowMs` — hit-event correlation window for single-point TEs.
- `now` — injectable clock for tests.

Client-side (in `ts-mvd/public/app.js`):

- `TRACE_TTL_MS` — fade duration.
- `TRACE_MAX` — ring buffer cap.
- `USE_SHOOTER_ORIGIN_AS_START` — when true, two-point lines start at
  the resolved shooter's player-icon origin rather than the raw muzzle
  position. Defaults to true for cleaner top-down lines.

## Edge cases

- Rail start points on the wire are at the muzzle, not the player
  center. `USE_SHOOTER_ORIGIN_AS_START` is the standard workaround.
- Z is ignored on the top-down render; lines project to XY.
- A replay reset or server-data change clears `recentHits` and the
  player reference via `ShotTraceResolver.reset()`.

## Verification

- Run the Jest suite: `npm test` (see `ts-mvd/test/shot-trace.test.ts`).
- Replay a demo with rail shots: confirm red/blue lines appear and
  fade, anchored to the shooter icon.
- Replay a demo with bullet weapons: confirm lines appear **only** when
  a hit was registered within ~250 ms; stray wall-hit TEs produce no
  line.
- `npm run build` must emit cleanly.
