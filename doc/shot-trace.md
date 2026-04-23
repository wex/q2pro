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
| `Blaster`       | 2   | `position` (impact) only  | Recent hit-event attacker |
| `Shotgun`       | 4   | `position` (impact) only  | Recent hit-event attacker |
| `Sparks`        | 9   | `position` (impact) only  | Recent hit-event attacker |
| `BulletSparks`  | 14  | `position` (impact) only  | Recent muzzleflash / hit attacker |
| `Blood`         | 1   | attacker origin → blood position | Recent muzzleflash |
| `GreenBlood`    | 26  | attacker origin → blood position | Recent muzzleflash |
| `MoreBlood`     | 42  | attacker origin → blood position | Recent muzzleflash |
| Synthetic hit   | —   | attacker origin → victim origin | Hit-event print (fallback) |

Explosions and all other TE types are not forwarded.

Blood TEs (`TE_BLOOD` and variants) are the primary attribution path for
AQ2 bullet-weapon player hits, because `fire_lead`/`fire_lead_ap` emit
*no* bullet TE when a round strikes a player — `T_Damage` writes
`TE_BLOOD` via `SpawnDamage` instead. The blood TE is correlated with
the most recent `svc_muzzleflash` (multicast, always in the stream) to
recover the shooter's clientNum (`entity - 1`). The line is drawn from
the shooter's live origin to the blood impact.

The hit-event synthetic path is a fallback that works only on servers
with `sv_mvd_nomsgs=0`. By default Q2Pro sets `sv_mvd_nomsgs=1`, which
filters unicast `"You hit X"` prints out of the MVD stream, so this
path is generally inactive.

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
- `Blaster` TEs are emitted only on world-geometry impacts (player
  hits instead raise a hit event and no TE). They use the same
  hit-correlation window as bullet TEs, so long-range blaster strays
  that never register a hit are dropped — matching the rule for
  `Gunshot`/`Shotgun`/`Sparks`/`BulletSparks`.
- Bullet weapons in AQ2 (sniper / MK23 / Dual / MP5 / M4 / HC) never
  emit a bullet TE when the round strikes a player — `fire_lead` calls
  `T_Damage` only, and `SpawnDamage` writes `TE_BLOOD` which is not
  visualized. Shot-trace lines for player hits are therefore synthesized
  from the `You hit NAME in the …` print: attacker clientNum comes from
  the unicast recipient, victim clientNum is resolved by name via
  `CS_PLAYERSKINS`. Attempts with an unresolved victim are dropped
  silently (same failure mode as a TE with no recent hit).
- Kevlar-helmet absorption is treated as a hit: AQ2 prints
  `"NAME has a Kevlar Helmet, too bad you have AP rounds..."` (sniper)
  or `"NAME has a Kevlar Helmet - AIM FOR THE BODY!"` instead of the
  usual `"You hit …"`. `classifyHit` matches both so those shots still
  produce a synthetic trace.

## Verification

- Run the Jest suite: `npm test` (see `ts-mvd/test/shot-trace.test.ts`).
- Replay a demo with rail shots: confirm red/blue lines appear and
  fade, anchored to the shooter icon.
- Replay a demo with bullet weapons: confirm lines appear **only** when
  a hit was registered within ~250 ms; stray wall-hit TEs produce no
  line.
- `npm run build` must emit cleanly.
