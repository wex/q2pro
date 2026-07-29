# MVD code re-analysis: players in stream, weapon / item / ammo detection

Research notes from a fresh pass over the reference C sources (`inc/`, `src/`)
of this AQtion-flavoured Q2Pro tree. Focus: how the MVD stream represents the
current set of players, and every channel available to a passive MVD/GTV
consumer (such as `ts-mvd`) for detecting a player's current weapon, carried
items, and ammo status. All file references are to the read-only C sources.

## 1. Source map

| Area | Files |
|------|-------|
| MVD emitter (server that hosts the game) | `src/server/mvd.c` |
| MVD consumer (GTV relay / demo player) | `src/server/mvd/client.c`, `src/server/mvd/parse.c`, `src/server/mvd/game.c`, `src/server/mvd/client.h` |
| Wire codec (delta read/write) | `src/common/msg.c`, `inc/common/msg.h`, `inc/common/protocol.h` |
| Shared structs, stats, configstrings | `inc/shared/shared.h` |
| Game logic that fills the data (AQ2/TNG) | `src/action/p_hud.c`, `src/action/p_weapon.c`, `src/action/g_items.c`, `src/action/g_spawn.c`, `src/action/g_local.h` |

## 2. Players currently in the stream

### 2.1 Which players the emitter captures

`player_is_active()` (`src/server/mvd.c` ~line 480) decides, per frame,
whether a client slot appears in the MVD `packetplayers` block:

- `ps.fov == 0` → never captured (invalid playerstate).
- The MVD dummy client is always captured.
- `pm_type == PM_SPECTATOR` → never captured.
- Otherwise gated by `sv_mvd_capture_flags` (default `5` = bits 1|4):
  - bit 0: require `cs_spawned` client state (excludes some bots),
  - bit 2 (default on): always capture entities that are visible
    (`!SVF_NOCLIENT` and has model/effects/sound/event),
  - remaining cases: `PM_FREEZE` or `PMF_NO_PREDICTION` → treated as
    "following someone", not captured.

Net effect: **every alive (and most just-died) player is present in the
packetplayers block each frame; free-floating spectators are not.**

### 2.2 Wire format of the roster (`mvd_frame` / gamestate)

Both the gamestate and every delta frame carry a *packetized playerstate*
list, terminated by client number `CLIENTNUM_NONE` (255):

```
byte   clientNum            (255 = end of list)
short  PPS bits             (PPS_MOREBITS -> one extra byte if MSG_PS_MOREBITS)
...    delta fields per bits
```

Written by `MSG_WriteDeltaPlayerstate_Packet()` (`src/common/msg.c` ~1735),
parsed by `MVD_ParsePacketPlayers()` (`src/server/mvd/parse.c` ~714) into
`mvd->players[number]`:

- `PPS_REMOVE` set → `player->inuse = false` (slot left the stream; on old
  demos without `MSG_PS_MOREBITS`, `PPS_MOREBITS` itself means remove).
- otherwise → `player->inuse = true` after applying the delta.

The consumer-side model is `mvd_player_t` (`src/server/mvd/client.h` 66):

```66:71:src/server/mvd/client.h
typedef struct {
    player_state_t ps;
    bool inuse;
    char name[16];
    mvd_cs_t *configstrings;
} mvd_player_t;
```

### 2.3 Player count and identity

- `MVD_PlayerToEntityStates()` (`src/server/mvd/parse.c` ~610) recomputes
  `mvd->numplayers` each frame: **count of `inuse` slots excluding the
  dummy**. This is the authoritative "players in stream" number (exported
  as serverinfo `mvd_players` in `src/server/mvd/game.c`).
- The dummy slot is `mvd->clientNum`, sent in `mvd_serverdata`. Its
  playerstate carries the scoreboard/observer view, never a real player.
- Names come from configstrings: `set_player_name()`
  (`src/server/mvd/game.c` ~1637) reads `CS_PLAYERSKINS + index` and cuts
  at the first `\` — format is `name\model/skin`. Updates arrive as
  `mvd_configstring` and must refresh the cached name
  (`MVD_UpdateConfigstring`).
- A player's map entity is edict `index + 1`; for alive players
  (`pm_type == PM_NORMAL`) origin/angles are lifted from the playerstate
  because the emitter suppresses them on the entity (`MSG_ES_FIRSTPERSON`).

## 3. What a playerstate in the stream contains

Key point: **unlike a regular Q2 connection where you only get your own
stats, the MVD stream carries a full `player_state_t` — including the
entire `stats[]` array — for every captured player, every frame.**

`MSG_ParseDeltaPlayerstate_Packet()` (`src/common/msg.c` ~3191) fields:

| PPS bit | Field | Notes |
|---------|-------|-------|
| `PPS_M_TYPE` | `pmove.pm_type` | `PM_NORMAL` = alive, `PM_DEAD`, `PM_GIB`... |
| `PPS_M_ORIGIN/2` | `pmove.origin` | short×8 (or delta-int23 with EXTENSIONS_2) |
| `PPS_VIEWANGLES/2` | `viewangles` | |
| `PPS_WEAPONINDEX` | `gunindex` | byte, or word with `MSG_PS_EXTENSIONS` |
| `PPS_WEAPONFRAME` | `gunframe` | weapon animation frame |
| `PPS_FOV` | `fov` | sniper zoom is visible here (15/30/45/90) |
| `PPS_STATS` | `stats[]` | 32-bit mask + shorts; varint64 mask + up to 64 stats with `MSG_PS_EXTENSIONS_2` (`MSG_ReadStats`, msg.c 2668) |

Emitter caveats (`src/server/mvd.c` ~2144): `sv_mvd_nogun 1` strips
`gunindex`/`gunframe`/`gunoffset`/`gunangles` (`MSG_PS_IGNORE_GUNINDEX |
MSG_PS_IGNORE_GUNFRAMES`); `sv_mvd_noblend 1` strips blends. Both default
to `0`, so guns are normally present. Stats are **never** stripped —
`MSG_CalcStatBits()` diffs the full array unconditionally.

## 4. Detecting the current weapon

Three independent, cross-checkable channels exist.

### 4.1 `gunindex` → view-model configstring (playerstate)

`ps.gunindex` is the model index of the weapon's *view model*. Resolve via
configstring `CS_MODELS + gunindex` and match the path:

| typeNum | Weapon | `view_model` (gunindex target) | HUD icon |
|---------|--------|--------------------------------|----------|
| 1 `MK23_NUM` | MK23 pistol | `models/weapons/v_blast/tris.md2` | `w_mk23` |
| 2 `MP5_NUM` | MP5/10 | `models/weapons/v_machn/tris.md2` | `w_mp5` |
| 3 `M4_NUM` | M4 assault rifle | `models/weapons/v_m4/tris.md2` | `w_m4` |
| 4 `M3_NUM` | M3 shotgun | `models/weapons/v_shotg/tris.md2` | `w_super90` |
| 5 `HC_NUM` | Handcannon | `models/weapons/v_cannon/tris.md2` | `w_cannon` |
| 6 `SNIPER_NUM` | SSG3000 sniper | `models/weapons/v_sniper/tris.md2` | `w_sniper` |
| 7 `DUAL_NUM` | Dual MK23 | `models/weapons/v_dual/tris.md2` | `w_akimbo` |
| 8 `KNIFE_NUM` | Combat knife | `models/weapons/v_knife/tris.md2` | `w_knife` |
| 9 `GRENADE_NUM` | M61 grenade | `models/weapons/v_handgr/tris.md2` | `a_m61frag` |
| 23 `GRAPPLE_NUM` | Grapple (CTF) | `models/weapons/grapple/tris.md2` | `w_grapple` |

(Numbers from `src/action/g_local.h` 637–667; model/icon strings from the
`itemlist` in `src/action/g_items.c` ~1340–1560.)

Caveats: the game zeroes `gunindex` while the sniper is zoomed
(`fov != 90`, `src/action/p_weapon.c` ~1860), when dead, at intermission,
and while idle-lowered — so `gunindex == 0` does **not** mean "no weapon".
Also unavailable entirely if the server set `sv_mvd_nogun 1`.

### 4.2 `entity_state.skinnum` high bits (works even when gunindex is 0)

AQ2's VWEP function `ShowGun()` (`src/action/p_weapon.c` 452) encodes the
carried weapon into the *player entity* state every time it changes:

```452:472:src/action/p_weapon.c
void ShowGun(edict_t* ent)
{
	int nIndex;
	// No weapon?
	if (!ent->client->weapon) {
		ent->s.modelindex2 = 0;
		return;
	}
	// Determine the weapon's precache index.
	nIndex = ent->client->weapon->typeNum;
	// Clear previous weapon model.
	ent->s.skinnum &= 255;
	// Set new weapon model.
	ent->s.skinnum |= (nIndex << 8);
	ent->s.modelindex2 = 255;
}
```

So on any player entity with `modelindex2 == 255`:
- `skinnum & 0xFF` = client number (set at spawn, `p_client.c` ~3217),
- `skinnum >> 8` = weapon `typeNum` (table above, 1–9 / 23).

This is delta-compressed in `packetentities`, present for **all** players,
and unaffected by zoom/bandage gunindex hiding. It is the most reliable
weapon channel for a top-down observer. Note it reflects the *equipped*
weapon; a dead player's dropped body has `modelindex2 = 0`.

### 4.3 Stats icons (playerstate `stats[]`)

`STAT_AMMO_ICON` (2) and `STAT_HELPICON` (11) carry image indices
resolvable via `CS_IMAGES + n`. `STAT_AMMO_ICON` distinguishes only ammo
family (`a_bullets` / `a_shells` / `w_knife` / `a_m61frag`, see
`src/action/g_spawn.c` 2043–2053), so it's a weaker signal than 4.1/4.2,
but useful as a liveness cross-check.

## 5. Detecting ammo status

All from `stats[]`, filled per-frame in `G_SetStats()`
(`src/action/p_hud.c` ~490–630). Stat indices from `inc/shared/shared.h`
1489–1524:

| Stat | Index | Meaning in AQ2/TNG |
|------|-------|--------------------|
| `STAT_HEALTH` | 1 | health (also alive/dead detection) |
| `STAT_AMMO` | 3 | **rounds loaded in the current weapon** (`mk23_rds`, `mp5_rds`, `m4_rds`, `shot_rds`, `cannon_rds`, `sniper_rds`, `dual_rds`; knife/grenade = inventory count) |
| `STAT_AMMO_ICON` | 2 | ammo family icon (image index) |
| `STAT_CLIP` | 17 | **spare magazines** for the current weapon (`inventory[ammo_index]`) |
| `STAT_CLIP_ICON` | 16 | spare-mag icon: `a_clip` (MK23/Dual), `a_mag` (MP5), `a_m4`, `a_shells` (M3/HC), `a_bullets` (sniper) |
| `STAT_GRENADES` | 29 | grenade count — **cycles with MedKit count** when both are carried (icon in `STAT_GRENADE_ICON` 28 tells which is showing: `a_m61frag` vs medkit icon) |
| `STAT_SNIPER_ICON` | 18 | sniper zoom-mode pic; nonzero = currently scoped (2x/4x/6x) |

Caveats:
- When a player dies, the game zeroes `STAT_AMMO_ICON`, `STAT_HEALTH_ICON`,
  `STAT_SELECTED_ICON` and `STAT_HELPICON` but `STAT_AMMO`/`STAT_CLIP`
  values may simply stop updating; gate ammo reads on
  `STAT_HEALTH > 0` / `pm_type == PM_NORMAL`.
- Reload state is not a stat; it can be inferred from `gunframe` ranges or
  from `STAT_SNIPER_ICON` going 0 while scoped (reload/busy).

## 6. Detecting carried items

- `STAT_SELECTED_ITEM` (12) = index into the game's `itemlist`; resolve the
  display name with configstring `CS_ITEMS + value` (`SetItemNames()`,
  `src/action/g_items.c` 2058 writes every `pickup_name` there).
- `STAT_WEAPONS_ICON` (20) — icon (image index) of a carried *special
  weapon*, rotating every `hud_items_cycle` seconds through
  `{SNIPER, M4, MP5, M3, HC, DUAL}` (`src/action/p_hud.c` 494–537).
- `STAT_ITEMS_ICON` (19) — same rotation for carried *special items*
  `{Kevlar, Helmet, Bandolier, Silencer, Stealth slippers, Lasersight}`
  with icons `p_kevlar`-style names (`p_silencer`, `p_bandolier`,
  `p_laser`, `p_rebreather` for helmet, etc.).
- Because the icons rotate, a consumer should **accumulate** the distinct
  icon indices seen while the stat is nonzero to reconstruct the full
  inventory, resetting on death (health ≤ 0) or round restart.
- Item numbers (`g_local.h`): SIL=10, SLIP=11, BAND=12, KEV=13, LASER=14,
  HELM=15; CTF flags 21/22 additionally show up as `modelindex3` on the
  player entity.

Icon-index → name resolution is always `CS_IMAGES + index` (the game
registers them via `gi.imageindex`, so they land in the image
configstring block, `level.pic_items` in `src/action/g_spawn.c` 2037).

## 7. Configstring bases (needed for all lookups)

From `inc/shared/shared.h` 1626–1664 — the remap depends on the protocol
announced in `mvd_serverdata` (`MVF_EXTLIMITS` → new/extended layout):

| Block | Classic (old) | Extended |
|-------|---------------|----------|
| `CS_MODELS` | 32 | 62 |
| `CS_IMAGES` | `CS_SOUNDS + MAX_SOUNDS` | same formula, larger maxima |
| `CS_ITEMS` | `CS_LIGHTS + MAX_LIGHTSTYLES` | " |
| `CS_PLAYERSKINS` | `CS_ITEMS + MAX_ITEMS` | " |

`ts-mvd` already handles the remap for player skins; weapon/item detection
needs the same treatment for `CS_MODELS`, `CS_IMAGES`, `CS_ITEMS`.

## 8. Relevance to ts-mvd

Already present in `ts-mvd/src/frame.ts`: per-player `inuse`, `gunindex`,
full `stats[]` parsing (32/64-wide), dummy-slot detection, name tracking.

Gaps a follow-up feature could close:

1. **Weapon resolver** — combine `entity_state.skinnum >> 8` (primary,
   needs `modelindex2 == 255` check in the entity parser) with
   `gunindex → CS_MODELS` (secondary) into a `weapon` field on the player
   model, using the typeNum table in §4.1.
2. **Ammo/loadout view** — surface `STAT_AMMO`, `STAT_CLIP`,
   `STAT_GRENADES` (with grenade/medkit disambiguation via
   `STAT_GRENADE_ICON`) per player, gated on alive state.
3. **Inventory accumulator** — track distinct `STAT_WEAPONS_ICON` /
   `STAT_ITEMS_ICON` image indices between deaths to list carried special
   weapons/items; resolve names via `CS_IMAGES`.
4. **Scope indicator** — `STAT_SNIPER_ICON != 0` or `fov < 90` marks a
   scoped sniper (useful on the map overlay).

## 9. Gotchas observed in the C code

- `PPS_MOREBITS` doubles as `PPS_REMOVE` on pre-`MSG_PS_MOREBITS` demos
  (`inc/common/protocol.h` 323); `ts-mvd` already implements this.
- `PPS_INUSE(ps)` reuses `pmove.pm_time` as an in-use flag on the emitter
  side only — never interpret `pm_time` from the stream.
- `mvd_stats_hack` / `mvd_stats_score` (`src/server/mvd/game.c` 699–721)
  only affect what a *relay* forwards to its own UDP observers; the GTV
  stream itself always carries the real per-player stats.
- The dummy's `stats[]` mirror the scoreboard layout owner, not a player;
  exclude `clientNum == mvd_serverdata.clientNum` from any per-player
  aggregation (already done for frags in ts-mvd).
- In-game chase-cam stat copying (`src/action/p_view.c` ~1614,
  `g_chase.c`) applies to in-game spectators, which `player_is_active()`
  excludes — it does not pollute the MVD roster.
