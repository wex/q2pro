# Damage-dealt stats (TE_DAMAGE_DEALT)

Branch: `feat/damage-stats`. Implements AUDIT-2 feature suggestion 2.

## Scope

Per-round, per-player **damage dealt** in the stats tracker, fed by AQ2's
`TE_DAMAGE_DEALT` temp entity. Surfaced as `damageDealt` on
`PlayerRoundStats` (`GET /stats`, `stats` SSE, `/events` snapshot) and as a
`Dmg` column in the Match-stats panel.

## Protocol

`p_view.c` (PlayerViewThink, lines 1697–1707): each frame the game flushes
`ent->client->damage_dealt` — when > 0 and the client speaks a hit-marker-
capable protocol (36 ≥ 1025 or 38 ≥ 3017) it sends
`svc_temp_entity [TE_DAMAGE_DEALT=128] [short damage]` **unicast to the
attacker**, then resets the accumulator. `g_combat.c` adds the raw `damage`
parameter on every `T_Damage` call, skipping friendly fire, warmup, and
`MOD_TELEFRAG` — i.e. the value is exactly the number the player's own hit
marker would show.

Properties:

- **Attacker-side only** — no victim, no position. It cannot resolve *who*
  was hit (combat-fx's nearest-player mapping stays separate); it only
  credits damage *dealt*.
- **Per-frame aggregate**, not per-shot — multiple hits in one server frame
  arrive as one short.
- Only sent to capable clients; the MVD dummy records the unicast for every
  recipient, so a GTV stream carries them for all attackers. Streams from
  servers/clients too old for hit markers simply never emit the type.

## Parser / tracker plumbing

- `TempEntityEvent.clientNum` — the unicast recipient (absent on
  multicast/broadcast TEs). For `TE_DAMAGE_DEALT` that is the attacker;
  `count` is the damage short. `parseTempEntity` now receives the inner
  `clientNum` and stamps it on both known and unknown-type events.
- `Session.onTempEntity` routes `DamageDealt` events with a `clientNum` to
  `stats.noteDamageDealt({ attacker, damage })` and schedules a coalesced
  stats broadcast (same 2 s window as hit updates — firefights don't spam
  SSE).
- `StatsTracker.noteDamageDealt` accumulates `damageDealt` on the current
  round's attacker row (name resolved via `namer`, same as hits); the
  snapshot folds it into `totals.players` alongside kills/deaths.

## UI

`#stats` gains a `Dmg` column between `Hits` and `Locations`; rows still
sort by kills. Damage lands under the per-round rows in the snapshot for
consumers that render rounds.

## Troubleshooting: `Dmg` shows all zeros

`Dmg` only accumulates when the stream actually carries `TE_DAMAGE_DEALT`.
Run the app with `TS_MVD_DEBUG=1 npm run app` — every arriving event logs
`[te] DAMAGE_DEALT client=N amount=M`. If none appear:

- **Replay of the bundled demo** — it predates hit markers and contains no
  `TE_DAMAGE_DEALT` at all; zeros are expected.
- **Attackers on old clients** — AQ2 only emits the TE when the attacker's
  client speaks a hit-marker protocol (36 ≥ 1025 / 38 ≥ 3017) and isn't a
  bot. A server full of old clients produces zero events even though the
  game tracks `damage_dealt` internally.
- **Non-AQ2 / old server** — the TE is AQ2/TNG-era; vanilla and older game
  DLLs never send it.

## Verification

`test/frame.test.ts` — unicast `TE_DAMAGE_DEALT` carries `clientNum`,
multicast does not. `test/stats.test.ts` — accumulation, totals fold,
per-round reset. `test/session.test.ts` — end-to-end wire bytes →
`stats.snapshot().damageDealt`. The bundled demo predates hit markers (0
such TEs) so coverage is synthetic.
