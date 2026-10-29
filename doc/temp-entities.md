# Temp-entity format table

Branch: `feat/tent-packet-port` (AUDIT-2 items 8 + 9)

## Problem

`parseTempEntity` only knew four hand-picked payload shapes (19 of the ~65
wire types). Every other `svc_temp_entity` — including three AQ2 types that
appear in real streams — hit the `unknown_temp_entity` bail-out and aborted
the rest of that unicast/multicast payload:

- `TE_TELEPORT_EFFECT` = 48 `[pos]` — jump pads (`tng_jump.c`)
- `TE_GRAPPLE_CABLE` = 24 `[e1 i16][pos][pos][pos]` — grapple hook
- `TE_DAMAGE_DEALT` = 128 `[count i16]` — per-hit damage, unicast to the
  attacker (`p_view.c`); the MVD recorder keeps unicast TEs, so this is a
  reliable per-hit signal for future exact-damage stats.

## Change

`TempEntityType` now mirrors the complete `temp_event_t` enum from
`inc/shared/shared.h` (vanilla 0-29, Rogue 30-55, Paril-KEX 56-63, AQ2
`TE_DAMAGE_DEALT` = 128), and the parser dispatches through a `TE_FORMAT`
table — one `TeFmt` per `case` group in `CL_ParseTEntPacket`
(`src/client/parse.c:857-994`):

| TeFmt | Wire layout | TEs |
|---|---|---|
| `PosDir` | `[pos][dir]` | blood, gunshot, sparks, shotgun, blaster(2), flechette, heatbeam sparks/steam, moreblood, electric sparks, bluehyperblaster 2, berserk slam |
| `CountPosDirColor` | `[count][pos][dir][color]` | splash, laser/welding/tunnel sparks |
| `PosOnly` | `[pos]` | all explosions, bosstport, plain explosion, chainfist smoke, tracker explosion, teleport effect, dball goal, widowsplash, nukeblast, explosion1/2 NL |
| `PosPos` | `[pos][pos]` | railtrail(2), bubbletrail(2), debugtrail, bfg laser/zap, bluehyperblaster |
| `EntPosPos` | `[e1][pos][pos]` | parasite/medic attack, heatbeam, monster heatbeam, grapple cable 2, lightning beam |
| `EntPosPosPos` | `[e1][pos][pos][pos]` | grapple cable (3rd pos = hook offset) |
| `EntEntPosPos` | `[e1][e2][pos][pos]` | lightning |
| `PosEnt` | `[pos][e1]` | flashlight |
| `PosPosColor` | `[pos][pos][color]` | forcewall |
| `Steam` | `[e1][count][pos][dir][color][e2]`(+`[time]` iff `e1 != -1`) | steam |
| `EntPos` | `[e1][pos]` | widowbeamout |
| `EntCount` | `[e1][count]` | power splash |
| `ShortOnly` | `[count i16]` | damage dealt |

`pos` decodes via the same `MSG_ES_EXTENSIONS_2`-aware path as entity
origins; entity fields read as signed i16 (TE_STEAM's `-1` sentinel
suppresses the trailing `time` long, matching C).

## Surfaced fields

`TempEntityEvent` gains `clientNum` (unicast recipient — for AQ2
`TE_DAMAGE_DEALT` this is the attacker, see `doc/damage-stats.md`),
`entity`, `entity2`, `count`, `color`, `dir`,
`offset`, `time` — all optional and only populated when the format carries
them. `TE_DAMAGE_DEALT`'s damage lands in `count` (a signed short —
negative values mean healing/knockback-only events per `p_view.c`).

## Deliberately unsupported

`TE_FLAME` (32) stays unmapped: the enum reserves the value but
`CL_ParseTEntPacket` has no case for it (`Com_Error` in C), so there is no
usable format to port. It still warns `unknown_temp_entity` and aborts the
payload walk — same as C, which drops the client entirely.

## muzzleflash2 masking fix

`svc_muzzleflash` masks `weapon & 0x7f` because bit 7 is `MZ_SILENCED`.
`svc_muzzleflash2` has no such bit — `MZ2_*` ids legitimately run past 127,
and under the extended protocol the high byte folded from `entity >> 13`
must survive. The mask is now applied only for player flashes
(`isPlayerFlash`), so `MuzzleFlashEvent.weapon` is correct for
monster/entity flashes.

## Gotcha: optional-call argument evaluation

The dispatch is deliberately `const ev = read(); onTempEntity?.(ev)` rather
than `onTempEntity?.(read())` — optional-call skips evaluating arguments
when the listener is null, which would leave the inner reader misaligned
and turn every un-listened TE into a phantom `unknown_svc_op`. (Caught by
the bundled demo, which carries 5 TEs in unlistened payloads.)

## Tests

`test/frame.test.ts` → `temp entity formats`: every format parsed with
field assertions, each followed by a trailing TE_BLOOD proving the inner
walk continues; AQ2 grapple/teleport/damage-dealt coverage; TE_FLAME still
warns and stops; truncated payloads abort cleanly. `muzzle flash ops` pins
the 0x7f mask on svc_muzzleflash and the unmasked value on svc_muzzleflash2.
