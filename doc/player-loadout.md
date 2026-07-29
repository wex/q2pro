# Player loadout (scoreboard HP / weapon / ammo)

Surfaces per-player health, current weapon, selected item, and ammo on the
browser scoreboard, driven by MVD stream data documented in
[fable-search.md](fable-search.md). Camera-lock behaviour that depends on
alive/loadout is in [player-lock.md](player-lock.md).

## Scope

| Surface | Source | Notes |
|---------|--------|-------|
| Status bar `"N player(s)"` | Current-frame stream roster (`inUse −` MVD dummy) | Strict [fable-search §2](fable-search.md) |
| Map icons | Same roster | Unchanged |
| Scoreboard membership | Frags merge + `CS_PLAYERSKINS` names | Existing behaviour |
| Scoreboard HP / Ammo + weapon/item icons before name | Live frame fields, with **sticky** last-seen cache | Cleared on playerskin CS empty or map change |

## Stream roster vs sticky loadout

- **Stream roster:** players present in the latest MVD `packetplayers` block
  with `inUse` and not the observer dummy. Status count and map use this.
- **Sticky loadout:** once a slot has been seen in the stream, the UI keeps
  the last HP/weapon/item/ammo on the scoreboard after brief `PPS_REMOVE` gaps
  (death/respawn). Cache entry is deleted when that slot's playerskin
  configstring is cleared (disconnect) or on `serverdata` (map change).
- **Sticky weapon (while alive):** if VWEP/`gunindex`/ammo-icon resolution
  returns empty for a still-alive player, the UI keeps the last known weapon
  label (important for scoped sniper where `gunindex` is 0). Cleared on death.

Never-streamed configstring-only rows still appear for frags with
`-` in the live columns.

## Scoreboard UI

Headers: **Name | HP | Ammo | Frags**.

Each row’s name cell is:

```
[weapon slot][item slot] name
```

with a 1px gap between slots and between slots and the name
(`td.name-cell` + `.loadout-icons` in `public/app.css`).

| Slot state | Render |
|------------|--------|
| No weapon/item | Empty 20×20 placeholder (`.sb-icon-empty`) |
| Label + mapped PNG | `<img class="sb-icon" src="/assets/…">` |
| Label, no map / image `onerror` | Red text (`.sb-icon-label`), e.g. Grapple |

### Icon asset map (`public/app.js`)

| Label | File |
|-------|------|
| MK23 | `w_mk23.png` |
| MP5 | `w_mp5.png` |
| M4 | `w_m4.png` |
| M3 | `w_super90.png` |
| HC | `w_cannon.png` |
| SSG | `w_sniper.png` |
| Dual | `w_akimbo.png` |
| Knife | `w_knife.png` |
| G | `a_m61frag.png` |
| Sil / Slip / Band / Kev / Helm / Laser | `p_silencer`, `slippers`, `p_bandolier`, `i_jacketarmor`, `p_rebreather`, `p_laser` |

Grapple has no PNG by design.

## Data pipeline

```
packetplayers  ──► PlayerState (stats, gunindex, pmType, fov)
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
              (weapon, item, ammo, clips, alive, scoped, …)
                         │
                         ▼
         public/app.js scoreboard + loadoutCache
```

### Weapon resolution (AQ2/TNG)

Order in `resolveWeaponTypeNum` / `resolveWeaponLabel`
([`ts-mvd/src/player-loadout.ts`](../ts-mvd/src/player-loadout.ts)):

1. Prefer entity VWEP: `modelindex2 === 255` ⇒ `weaponTypeNum = skinnum >> 8`
   (see `ShowGun` in `src/action/p_weapon.c`). **Unaffected by sniper zoom.**
2. Else match `CS_MODELS + gunindex` path against known view models
   (`v_blast` → MK23, `v_machn` → MP5, `v_sniper` → SSG, `v_dual` → Dual, …).
3. `gunindex` may be 0 while scoped (`fov != 90` in `p_weapon.c`), point at
   `sprites/null.sp2`, or be stripped by `sv_mvd_nogun` — do **not** treat
   that as “unarmed”.
4. Else map HUD icons (`STAT_CLIP_ICON` then `STAT_AMMO_ICON` → `CS_IMAGES`):
   - **CLIP** (ammo-item icons): `a_clip`→MK23, `a_mag`→MP5, `a_m4`→**M4**,
     `a_shells`→M3, `a_bullets`→SSG. Dual shares `a_clip`; HC shares
     `a_shells`.
   - **AMMO** (weaker): only `a_clip`→MK23, `a_shells`→M3, `w_knife`→Knife,
     `a_m61frag`→G. Do **not** map `a_bullets` here — MK23/MP5/M4/Dual/SSG
     all use it for `STAT_AMMO_ICON`.
5. UI sticky last-known weapon while alive (see above).

Short labels: MK23, MP5, M4, M3, HC, SSG, Dual, Knife, G, Grapple.

### Selected item

Primary: `STAT_ITEMS_ICON` (19) → `CS_IMAGES` (classic base 544, extended
10302). AQ2 cycles the HUD icon among carried specials
(Kev/Helm/Band/Sil/Slip/Laser). The scoreboard shows the **current** icon
in that rotation, not a full inventory list.

Fallback: `STAT_SELECTED_ITEM` → `CS_ITEMS`, but **only** for known special
pickup names. `selected_item` usually indexes the equipped weapon (e.g.
`"MK23 Pistol"`), which must not appear as the item.

### Ammo

From `stats[]` when alive (`pmType === PM_NORMAL` and `STAT_HEALTH > 0`):

- `STAT_AMMO` — rounds in magazine (displayed as `ammo/clips`)
- `STAT_CLIP` — spare magazines
- `STAT_GRENADES` — raw HUD value (may alternate with medkit; not shown on
  the scoreboard column)

Dead / away rows show `-` for HP/Ammo; weapon/item slots use empty
placeholders when there is no sticky alive loadout.

### Scoped

SSE also carries `scoped: boolean` (`fov < 90` or `STAT_SNIPER_ICON != 0`).
Used for loadout cache metadata; map overlay scope FX is optional/future.

## Files

| File | Role |
|------|------|
| `ts-mvd/src/player-loadout.ts` | Resolve weapon/item labels + ammo helpers |
| `ts-mvd/src/frame.ts` | Cumulative player-edict VWEP state → `weaponTypeNum` |
| `ts-mvd/src/protocol.ts` | Extended `Stat` / `PmType` |
| `ts-mvd/src/app.ts` | SSE enrichment via `serializePlayerForSse` |
| `ts-mvd/public/app.js` | Icons, sticky `loadoutCache`, scoreboard layout |
| `ts-mvd/public/assets/` | Weapon/item PNGs |
| `ts-mvd/test/player-loadout.test.ts` | Resolver unit tests |

## Limitations

- Labels and icon maps are **AQ2/TNG-specific**.
- Clip/ammo-icon fallback collapses Dual→MK23 and HC→M3 (`a_clip` /
  `a_shells`). `a_bullets` is only trusted via `STAT_CLIP_ICON` (sniper).
- Sticky can show stale loadout for a connected client no longer in the
  stream (e.g. spectating). Map layer stays current-frame only.
- Full inventory accumulation across `STAT_WEAPONS_ICON` /
  `STAT_ITEMS_ICON` rotations is out of scope (current special only).
