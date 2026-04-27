# Player health bars and death icons

Visualizes per-player health on the live map and renders a fading skull glyph at the spot where each player dies.

## Data flow

```
MVD stream                           Browser
─────────────                        ───────
parseStats(ps)                       SSE 'frame' { players[i].health }
  prevHealth = ps.stats[STAT_HEALTH] ─────────────► renderPlayers()
  apply stat deltas                                     └─► HP bar above name
  if prevHealth>0 && new<=0          SSE 'death' { clientNum, origin, t }
    onDeath({ clientNum, origin })  ───────────────► handleDeath()
                                                         └─► deaths[] → skull FX
```

## Server side (`ts-mvd/src/`)

- `protocol.ts` — `Stat.Health = 1` (matches `STAT_HEALTH` in `inc/shared/shared.h`).
- `frame.ts`
  - `DeathEvent { clientNum, origin: [x,y,z] }` (world-space).
  - `MvdFrameParser.onDeath` callback.
  - `parseStats` snapshots `prevHealth` before applying the new stat bits and fires `onDeath` whenever health transitions from `>0` to `<=0`. Origin is converted via `originToWorld` (the same 1/8 scaling used elsewhere).
- `app.ts`
  - Per-frame SSE payload now carries `health` per player (`p.stats[Stat.Health]`).
  - `parser.onDeath` is wired to broadcast a new SSE `death` event.

## Client side (`ts-mvd/public/app.js`)

### Health bar

Drawn in `renderPlayers` immediately above each player's name when `ent.health` is a number:

- Width `r * 2.2`, height `max(3, 4 / transform.scale)`.
- Background: translucent black; foreground proportional to `clamp(hp, 0, 100) / 100`.
- Colour thresholds: ≥66 green, ≥33 yellow, otherwise red.
- Skipped entirely when health is `undefined` (e.g. legacy demos with no STAT_HEALTH bit).

### Death icon

The previous "kill X" rendering (anchored to obituary name lookup) is replaced by a health-driven skull:

- TTL `DEATH_ICON_TTL_MS = 1500` ms (≈1.5 s, within the 1–2 s requested range).
- Glyph `\u2620` (☠), sized 28 px with a slight 1.0 → 1.25 grow during the lifetime, alpha fading to 0.
- Drawn with a black stroke for contrast on bright maps.
- Triggered by the SSE `death` event from the server (one entry per `STAT_HEALTH` 0→ transition).

### Reset semantics

Existing reset paths (`resetPipelineState` server-side, snapshot/serverdata listeners client-side) already flush `players` and the FX arrays. No additional bookkeeping is needed: the `deaths[]` array drains itself once entries pass `DEATH_ICON_TTL_MS`.

## Tests

- `ts-mvd/test/frame.test.ts` adds a death-event smoke test using the bundled `demo.mvd2` fixture (which contains 2 deaths). The test asserts every captured death has a valid client number and finite world-space origin.

Run from `ts-mvd/`:

```
npm test
npm run build
```
