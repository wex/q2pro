# Player loadout (scoreboard HP / weapon / ammo)

Surfaces per-player health, current weapon, selected item, and ammo on the
browser scoreboard, driven by MVD stream data documented in
[fable-search.md](fable-search.md).

## Scope

| Surface | Source | Notes |
|---------|--------|-------|
| Status bar `"N player(s)"` | Current-frame stream roster (`inUse −` MVD dummy) | Strict [fable-search §2](fable-search.md) |
| Map icons | Same roster | Unchanged |
| Scoreboard membership | Frags merge + `CS_PLAYERSKINS` names | Existing behaviour |
| Scoreboard HP / Wpn / Item / Ammo | Live frame fields, with **sticky** last-seen cache | Cleared on playerskin CS empty or map change |

## Stream roster vs sticky loadout

- **Stream roster:** players present in the latest MVD `packetplayers` block
  with `inUse` and not the observer dummy. Status count and map use this.
- **Sticky loadout:** once a slot has been seen in the stream, the UI keeps
  the last HP/weapon/item/ammo on the scoreboard after brief `PPS_REMOVE` gaps
  (death/respawn). Cache entry is deleted when that slot's playerskin
  configstring is cleared (disconnect) or on `serverdata` (map change).

Never-streamed configstring-only rows still appear for frags with
`-` in the live columns.

## Data pipeline

```
packetplayers  ──► PlayerState (stats, gunindex, pmType)
packetentities ──► cumulative player-edict skinnum/modelindex2
                         │
                         ▼
              weaponTypeNum (raw, frame.ts)
                         │
                         ▼
         player-loadout.ts + configstrings (app.ts)
                         │
                         ▼
              SSE frame / snapshot players[]
                         │
                         ▼
         public/app.js scoreboard + loadoutCache
```

### Weapon resolution (AQ2/TNG)

1. Prefer entity VWEP: `modelindex2 === 255` ⇒ `weaponTypeNum = skinnum >> 8`
   (see `ShowGun` in `src/action/p_weapon.c`).
2. Else match `CS_MODELS + gunindex` path against known view models
   (`v_blast` → MK23, `v_machn` → MP5, …).
3. `gunindex` may be 0 while scoped (`sv_mvd_nogun` also strips it).

### Selected item

Primary signal: `STAT_ITEMS_ICON` (19) → `CS_IMAGES + index` (classic base
544, extended 10302). AQ2 writes the HUD icon for a carried special here
(cycling through Kev/Helm/Band/Sil/Slip/Laser when several are held).

Icon paths map to short labels: `p_silencer`→Sil, `slippers`→Slip,
`p_bandolier`→Band, `i_jacketarmor`→Kev, `p_laser`→Laser,
`p_rebreather`→Helm.

Fallback: `STAT_SELECTED_ITEM` → `CS_ITEMS`, but **only** for known special
pickup names. `selected_item` usually indexes the equipped weapon (full
names like "MK23 Pistol"), which must not appear in the Item column.

### Ammo

From `stats[]` when alive (`pmType === PM_NORMAL` and `STAT_HEALTH > 0`):

- `STAT_AMMO` — rounds in magazine
- `STAT_CLIP` — spare magazines
- `STAT_GRENADES` — raw HUD value (may alternate with medkit)

Dead / away-in-frame rows show `-` for HP/Wpn/Item/Ammo.

## Files

| File | Role |
|------|------|
| `ts-mvd/src/player-loadout.ts` | Resolve weapon/item labels + ammo helpers |
| `ts-mvd/src/frame.ts` | Cumulative player-edict VWEP state → `weaponTypeNum` |
| `ts-mvd/src/protocol.ts` | Extended `Stat` / `PmType` |
| `ts-mvd/src/app.ts` | SSE enrichment via `serializePlayerForSse` |
| `ts-mvd/public/app.js` | Scoreboard columns + sticky `loadoutCache` |

## Limitations

- Weapon/item short labels are **AQ2/TNG-specific**; unknown CS names show
  the raw pickup string or `-`.
- Sticky can display stale loadout for a connected client no longer in the
  stream (e.g. spectating). Map layer stays current-frame only.
- Inventory rotation icons (`STAT_WEAPONS_ICON` / `STAT_ITEMS_ICON`) are
  out of scope.
