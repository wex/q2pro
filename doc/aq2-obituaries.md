# AQ2 obituary table

`ts-mvd/src/aq2-obituaries.ts` ports AQ2/TNG's `ClientObituary`
(`src/action/p_client.c:1035–`) into a data-driven matcher so every death
line the mod can emit classifies into a structured `ObituaryEvent`.

## Wire shapes

`ClientObituary` composes death lines from three `sprintf` shapes:

| Shape | Format | Meaning |
|-------|--------|---------|
| kill | `"%s%s %s%s"` = victim + `message` + `" "` + attacker + `message2` | credited kill |
| special | `"%s %s %s"` = victim + `" "` + `special_message` + `" "` + attacker | push/throw deaths (window, fall, slime, lava, edge) — AQ2 credits the attacker |
| world | `"%s %s"` = victim + `" " + message` | environmental or self death |

`message`/`message2` come from a fixed table of ~90 literals keyed by
`MOD_*` and (for the gun/knife mods) `locOfDeath`, so the wire text is
fully enumerable. Gender variants (`pers.gender`) are written once with
slots — `{g}` → `his|her|its`, `{o}` → `him|her|it`,
`{s}` → `himself|herself|itself` — and expanded into regex alternations.

## Classification

`classifyAq2Obituary(raw)` returns
`{kind, victim, attacker, mod, location}` or `null` when the line is not
a death (e.g. bot nav "Saving node table...", rename notices — those
arrive on the same PRINT_MEDIUM channel).

- **Match order** is longest-`message2` first: several `message` bodies
  are shared between mods (`" was shot by"` ×4, `" caught"` ×3,
  `" was shot in the legs by"` sniper-vs-dual) and are only separable by
  the weapon suffix. Entries without a `message2` act as the fallback for
  their `message` string.
- **Names are best-effort**: victim/attacker captures are non-greedy /
  greedy-to-suffix, so a player literally named `x was shot by y` will
  mis-split. Acceptable and documented.
- **No-leading-space messages**: the vanilla-retained templates
  (`"was blasted by"`, `"was popped by"`, `"was shredded by"`,
  `"was melted by"`) concatenate directly onto the netname
  (`"Vicwas blasted by Att"`) — the victim capture is `trimEnd()`ed so
  the name still matches playerskin configstrings on vanilla-format
  lines (`"Vic was blasted by Att"`).

`weapon` on the event is the MOD-derived token (`mk23`, `mp5`, `m4`,
`m3`, `hc`, `sniper`, `dual`, `knife`, `knife_thrown`, `kick`, `punch`,
`blaster`, `grenade`, `g_splash`, `hyperblaster`, `handgrenade`,
`hg_splash`, `held_grenade`, `telefrag`, `grapple`, `grenade_impact`;
world/self causes: `suicide`, `falling`, `crush`, `water`, `slime`,
`lava`, `explosive`, `exit`, `laser`, `turret`, `splash`, `glass`,
`unknown`). `location` is `head|chest|stomach|legs|body` when the
template encodes one (loc-specific strings only exist for the gun and
knife mods).

## `kind` and downstream consumers

`ObituaryEvent.kind` is one of `kill | world | suicide | info`:

- `kill` → stats award the attacker a kill + weapon tally
  (`StatsTracker.noteObituary`).
- `world` / `suicide` → death lines only (deaths themselves come from
  the authoritative `STAT_HEALTH → 0` edge via `noteDeath`).
- `info` → not a death line; the kill feed renders it dimmed
  (`.info` in `app.css`) and stats ignore it. `victim === ''` remains the
  "raw-only" contract for older consumers.

Vanilla Q2 templates are still tried as a fallback when the AQ2 table
doesn't match, so non-AQ2 streams keep working.

## Parity test

`test/aq2-obituaries.test.ts` slices `ClientObituary` out of
`src/action/p_client.c`, strips `//` comments (the C source keeps dead
template lines), and asserts that every `message` / `message2` /
`special_message` string literal is covered by `expandedTemplates()` —
the table cannot silently drift from what the server emits. A second
pass synthesizes `victim + m + ' ' + attacker + m2` lines for every
expanded template and asserts they classify with the right `mod`.
