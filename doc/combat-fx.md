# Combat FX (map overlay)

In-place visual effects on the top-down map view: a brief cone glow when
a player fires, coloured particles + a pulse ring on a player who just
took damage, and a fading red `X` on a player who was killed. There are
no world-space shot lines.

## Scope

Three independent FX channels:

| Channel | Trigger | Visual                                            |
|---------|---------|---------------------------------------------------|
| Flash   | `svc_muzzleflash` (multicast)          | Cone fill/stroke brighter; duration keyed to `MZ_*` weapon id. |
| Damage  | `TE_BLOOD` / `TE_GREENBLOOD` / `TE_MOREBLOOD` / `TE_BULLET_SPARKS` / `TE_SPARKS` near a live player | 8-particle burst (red=blood, yellow=sparks) + expanding ring on the victim. Rate-limited. |
| Kill X  | Obituary (`PRINT_MEDIUM`)              | Fading red cross at the victim's last-known origin. |

Explosions, rail trails, bubble trails, blaster impacts, and any other
TE types are ignored by the combat-FX pipeline. Wall-impact sparks are
rejected by a nearest-player distance cap (`victimMaxDist`, default 80
world units) so a knife-on-wall `TE_SPARKS` does not paint a bystander.

## Architecture

```
MVD stream ─► frame.ts ─► onMuzzleFlash ─► app.ts: SSE 'flash'   ─┐
                                                                  │
           ─► frame.ts ─► onTempEntity  ─► CombatFxResolver       │
                                               │                  │
                                               ▼                  │
                                         DamageEvent              │
                                               │                  │
                                          SSE 'damage'  ─────────▶│
                                                                  │
           ─► frame.ts ─► onObituary    ─► SSE 'kill'    ────────▶│
                                                                  ▼
                                              public/app.js renderPlayers()
                                                │
                                                ├── flashes   (cone glow)
                                                ├── bursts+particles (damage)
                                                ├── killXs   (red X)
```

- `ts-mvd/src/combat-fx.ts` — **pure module**, `CombatFxResolver`. No I/O,
  no SSE dependency. Nearest-player attribution within `victimMaxDist`.
- `ts-mvd/src/app.ts` — owns the resolver instance, broadcasts three
  SSE events. No persistent per-shot state beyond the resolver.
- `ts-mvd/public/app.js` — owns all rendering, TTLs, rate-limiting,
  and kill-X name→clientNum resolution.
- Tests: `ts-mvd/test/combat-fx.test.ts` exercises the pure resolver.

## Wire contract

```ts
// Every player's primary-fire muzzleflash.
interface FlashEvent {
    shooter: number;   // clientNum = edict - 1
    weapon: number;    // MZ_* id (low 7 bits)
    silenced: boolean;
    t: number;
}

// Damage-on-player TE landed near a live player.
interface DamageEvent {
    victim: number;               // nearest player's clientNum
    kind: 'blood' | 'sparks';
    position: [number, number, number];
    t: number;
}
```

The existing `kill` (obituary), `hit`, `frame`, `snapshot`, etc. SSE
events are unchanged. The previous `shot` event is **removed**.

## Resolution rules

### Flash
Every `svc_muzzleflash` becomes a `flash` SSE. Server-side: no state,
just `{ shooter: entity - 1, weapon, silenced, t: Date.now() }`.

### Damage
`CombatFxResolver.handleTE(ev)` classifies `ev.type` into blood / sparks
and returns `{ victim, kind, position, t }` if and only if the TE has a
position and there is a live player within `victimMaxDist` of it. Picks
the nearest such player. Returns null otherwise (wall impacts, TEs we
don't care about, or when the player map is empty).

### Kill
No server-side addition. The browser listens to the existing `kill`
event, resolves the victim name through `CS_PLAYERSKINS_*`, and queues
a fading `X` at that player's live origin.

## Browser tuning constants

In `ts-mvd/public/app.js`:

- `FLASH_DURATION_DEFAULT_MS = 120` — fallback flash duration.
- `FLASH_DURATION_MS_BY_MZ` — per-weapon override table (`MZ_RAILGUN`
  260 ms, `MZ_SHOTGUN2`/AQ2 sniper 260 ms, `MZ_BFG` 240 ms, etc.).
  Stacking behaviour: a new flash extends the existing `until`
  timestamp but never shortens it.
- `PARTICLE_COUNT = 8`, `PARTICLE_TTL_MS = 600`, speeds 20–60 px/s.
- `RING_TTL_MS = 300`, `RING_EXPAND_PX = 14`.
- `DAMAGE_COOLDOWN_MS = 80` — per-victim rate limit. Within the window,
  `blood` upgrades a pending `sparks`; otherwise the later event is
  dropped (prevents shotgun pellet floods).
- `KILL_X_TTL_MS = 800`.

## Server tuning

`CombatFxResolver` constructor options:

- `victimMaxDist` — default `80`. Increase if bullet-sparks appear
  detached from players on some maps; decrease if wall hits leak into
  bystanders.
- `now` — injectable clock for tests.

## Edge cases

- Flash entry is evicted once `until` falls below the current frame's
  clock, so idle spectators don't keep the render loop ticking forever.
- Particles, bursts, and kill-Xs all re-anchor to the victim's live
  origin per frame, so they track a moving target until TTL.
- If the killed player isn't in `players` (off-map / disconnected),
  the kill X is silently dropped.
- `sv_mvd_nomsgs` (Q2Pro default 1) does not affect this pipeline:
  muzzleflashes and TEs are multicast, obituaries are `PRINT_MEDIUM`.

## Verification

- `npm test` in `ts-mvd/` — includes `combat-fx.test.ts` (resolver unit
  tests).
- `npm run build` — clean.
- Manual: replay an AQ2 demo or connect to live GTV and confirm
  per-shot cone glow, sparks/blood particles on damaged players,
  pulse rings, rate-limited shotgun bursts, and a red X on obituary.
