/**
 * AQ2/TNG player loadout helpers for MVD streams.
 *
 * Resolves weapon id/label, selected item, and ammo from raw playerstate +
 * entity signals. Label resolution needs configstrings (CS_MODELS /
 * CS_ITEMS); call from app.ts, not from the frame parser. See
 * doc/fable-search.md §4–§6 and doc/player-loadout.md.
 */

import { PmType, Stat } from './protocol';

/** Configstring bases for CS_MODELS (classic vs MVF_EXTLIMITS). */
export const CS_MODELS_OLD = 32;
export const CS_MODELS_EXT = 62;

/** Configstring bases for CS_ITEMS (= CS_PLAYERSKINS − MAX_ITEMS). */
export const CS_ITEMS_OLD = 1056;
export const CS_ITEMS_EXT = 12606;

/** Configstring bases for CS_IMAGES (for STAT_ITEMS_ICON resolution). */
export const CS_IMAGES_OLD = 544;
export const CS_IMAGES_EXT = 10302;

/** Configstring bases for CS_PLAYERSKINS (disconnect detection). */
export const CS_PLAYERSKINS_OLD = 1312;
export const CS_PLAYERSKINS_EXT = 12862;

/** Configstring index holding the maxclients count. */
export const CS_MAXCLIENTS_OLD = 30;
export const CS_MAXCLIENTS_EXT = 60;

/** Configstring bases for CS_SOUNDS (sound index → sample name). */
export const CS_SOUNDS_OLD = 288;
export const CS_SOUNDS_EXT = 8254;

/**
 * Configstring base indices for one Q2Pro stream layout. `MVF_EXTLIMITS`
 * streams use `cs_remap_new` (CS_LAYOUT_EXT); everything else uses the
 * vanilla layout. Always pick exactly one set — probing both misfires
 * because the EXT bases alias into the vanilla CS_MODELS range (e.g.
 * `CS_MAXCLIENTS_EXT` = 60 is `CS_MODELS_OLD + 28`, a model path).
 */
export interface CsLayout {
    models: number;
    images: number;
    items: number;
    playerskins: number;
    maxclients: number;
    sounds: number;
}

export const CS_LAYOUT_OLD: CsLayout = {
    models: CS_MODELS_OLD,
    images: CS_IMAGES_OLD,
    items: CS_ITEMS_OLD,
    playerskins: CS_PLAYERSKINS_OLD,
    maxclients: CS_MAXCLIENTS_OLD,
    sounds: CS_SOUNDS_OLD,
};

export const CS_LAYOUT_EXT: CsLayout = {
    models: CS_MODELS_EXT,
    images: CS_IMAGES_EXT,
    items: CS_ITEMS_EXT,
    playerskins: CS_PLAYERSKINS_EXT,
    maxclients: CS_MAXCLIENTS_EXT,
    sounds: CS_SOUNDS_EXT,
};

/** Select the configstring layout for `ServerDataEvent.extended`. */
export function csLayout(extended: boolean): CsLayout {
    return extended ? CS_LAYOUT_EXT : CS_LAYOUT_OLD;
}

/** AQ2 weapon typeNum → short label (g_local.h MK23_NUM … GRAPPLE_NUM). */
export const AQ2_WEAPON_LABELS: Readonly<Record<number, string>> = {
    1: 'MK23',
    2: 'MP5',
    3: 'M4',
    4: 'M3',
    5: 'HC',
    6: 'SSG',
    7: 'Dual',
    8: 'Knife',
    9: 'G',
    23: 'Grapple',
};

/** AQ2 special-item pickup_name → short scoreboard label. */
export const AQ2_ITEM_LABELS: Readonly<Record<string, string>> = {
    'Silencer': 'Sil',
    'Stealth Slippers': 'Slip',
    'Bandolier': 'Band',
    'Kevlar Vest': 'Kev',
    'Kevlar Helmet': 'Helm',
    'Lasersight': 'Laser',
};

/** CS_IMAGES icon path (from gi.imageindex) → short label for specials. */
export const AQ2_ITEM_ICON_LABELS: Readonly<Record<string, string>> = {
    'p_silencer': 'Sil',
    'slippers': 'Slip',
    'p_bandolier': 'Band',
    'i_jacketarmor': 'Kev',
    'p_laser': 'Laser',
    'p_rebreather': 'Helm',
};

/** view_model path fragments → typeNum (g_items.c itemlist). */
const VIEW_MODEL_TO_TYPE: ReadonlyArray<{ frag: string; typeNum: number }> = [
    { frag: 'v_blast', typeNum: 1 },
    { frag: 'v_machn', typeNum: 2 },
    { frag: 'v_m4', typeNum: 3 },
    { frag: 'v_shotg', typeNum: 4 },
    { frag: 'v_cannon', typeNum: 5 },
    { frag: 'v_sniper', typeNum: 6 },
    { frag: 'v_dual', typeNum: 7 },
    { frag: 'v_knife', typeNum: 8 },
    { frag: 'v_handgr', typeNum: 9 },
    { frag: 'grapple/tris', typeNum: 23 },
];

/**
 * STAT_CLIP_ICON → weapon (ammo-item icons from g_items.c).
 * a_m4 / a_mag / a_bullets are unambiguous; a_clip and a_shells collapse
 * Dual→MK23 and HC→M3 (same family as STAT_AMMO_ICON).
 */
const CLIP_ICON_WEAPON_LABELS: Readonly<Record<string, string>> = {
    a_clip: 'MK23',     // pistol magazines (MK23 / Dual)
    a_mag: 'MP5',
    a_m4: 'M4',
    a_shells: 'M3',     // shotgun shells (M3 / HC)
    a_bullets: 'SSG',   // sniper spare ammo only (not STAT_AMMO_ICON)
};

/**
 * STAT_AMMO_ICON → weapon. Weaker: MK23/MP5/M4/Dual/SSG all use a_bullets,
 * so only map the family icons that are unique enough for scoreboard guess.
 */
const AMMO_ICON_WEAPON_LABELS: Readonly<Record<string, string>> = {
    a_clip: 'MK23',
    a_shells: 'M3',
    w_knife: 'Knife',
    a_m61frag: 'G',
};

export interface WeaponResolveInput {
    /** From entity skinnum>>8 when modelindex2===255; preferred. */
    weaponTypeNum?: number;
    /** player_state.gunindex; secondary via CS_MODELS. */
    gunindex?: number;
    /** Live stats for ammo-icon fallback (STAT_CLIP_ICON / STAT_AMMO_ICON). */
    stats?: ArrayLike<number>;
    /** Gate ammo-icon fallback on alive. */
    alive?: boolean;
}

export interface AmmoStatus {
    /** Rounds loaded in current weapon (STAT_AMMO). */
    ammo: number;
    /** Spare magazines (STAT_CLIP). */
    clips: number;
    /** STAT_GRENADES (may cycle with medkit — raw value). */
    grenades: number;
}

export function weaponLabel(typeNum: number): string | undefined {
    return AQ2_WEAPON_LABELS[typeNum];
}

export function isAlive(pmType: number, health: number): boolean {
    return pmType === PmType.Normal && health > 0;
}

export function isScoped(fov: number, sniperIcon: number): boolean {
    return fov < 90 || sniperIcon !== 0;
}

/**
 * Prefer entity vwep typeNum; else match CS_MODELS[gunindex] path;
 * else STAT_CLIP_ICON (a_m4/a_mag/…) then STAT_AMMO_ICON family icons.
 * Returns typeNum or undefined if unknown.
 *
 * `extended` must match `ServerDataEvent.extended` so configstrings are
 * read from the correct layout (defaults to vanilla).
 */
export function resolveWeaponTypeNum(
    input: WeaponResolveInput,
    configstrings: Map<number, string> | Record<number, string>,
    extended = false,
): number | undefined {
    const fromEntity = input.weaponTypeNum;
    if (fromEntity != null && fromEntity > 0 && AQ2_WEAPON_LABELS[fromEntity]) {
        return fromEntity;
    }

    const gun = input.gunindex ?? 0;
    if (gun > 0) {
        const path = lookupModel(configstrings, gun, csLayout(extended).models);
        if (path) {
            const lower = path.toLowerCase();
            for (const { frag, typeNum } of VIEW_MODEL_TO_TYPE) {
                if (lower.includes(frag)) return typeNum;
            }
        }
    }

    const fromAmmo = resolveWeaponLabelFromAmmo(input, configstrings, extended);
    if (fromAmmo) {
        for (const [num, label] of Object.entries(AQ2_WEAPON_LABELS)) {
            if (label === fromAmmo) return Number(num);
        }
    }
    return undefined;
}

export function resolveWeaponLabel(
    input: WeaponResolveInput,
    configstrings: Map<number, string> | Record<number, string>,
    extended = false,
): string | undefined {
    const typeNum = resolveWeaponTypeNum(input, configstrings, extended);
    return typeNum != null ? weaponLabel(typeNum) : undefined;
}

/**
 * Last-resort weapon guess from clip/ammo HUD icons.
 * Prefer STAT_CLIP_ICON (ammo-item icons; includes a_m4→M4). STAT_AMMO_ICON
 * only maps family icons — never a_bullets (shared by several guns).
 */
export function resolveWeaponLabelFromAmmo(
    input: WeaponResolveInput,
    configstrings: Map<number, string> | Record<number, string>,
    extended = false,
): string | undefined {
    if (!input.alive || !input.stats) return undefined;
    const stats = input.stats;
    const imagesBase = csLayout(extended).images;

    const clipIdx = (stats[Stat.ClipIcon] as number | undefined) ?? 0;
    if (clipIdx > 0) {
        const label = iconPathToLabel(lookupImage(configstrings, clipIdx, imagesBase), CLIP_ICON_WEAPON_LABELS);
        if (label) return label;
    }

    const ammoIdx = (stats[Stat.AmmoIcon] as number | undefined) ?? 0;
    if (ammoIdx > 0) {
        return iconPathToLabel(lookupImage(configstrings, ammoIdx, imagesBase), AMMO_ICON_WEAPON_LABELS);
    }
    return undefined;
}

function iconPathToLabel(
    iconPath: string,
    map: Readonly<Record<string, string>>,
): string | undefined {
    if (!iconPath) return undefined;
    const base = iconPath.replace(/^.*\//, '').toLowerCase();
    return map[base];
}

export function extractAmmo(stats: ArrayLike<number>, alive: boolean): AmmoStatus | undefined {
    if (!alive) return undefined;
    const ammo = (stats[Stat.Ammo] as number | undefined) ?? 0;
    const clips = (stats[Stat.Clip] as number | undefined) ?? 0;
    const grenades = (stats[Stat.Grenades] as number | undefined) ?? 0;
    return { ammo: ammo | 0, clips: clips | 0, grenades: grenades | 0 };
}

/**
 * Resolve the special item shown on the scoreboard.
 *
 * Primary: STAT_ITEMS_ICON → CS_IMAGES (AQ2 HUD cycles carried specials here).
 * Fallback: STAT_SELECTED_ITEM → CS_ITEMS, but only if the pickup name is a
 * known special — selected_item usually indexes the equipped weapon.
 */
export function resolveSelectedItem(
    stats: ArrayLike<number>,
    alive: boolean,
    configstrings: Map<number, string> | Record<number, string>,
    extended = false,
): string | undefined {
    if (!alive) return undefined;

    const layout = csLayout(extended);
    const iconIdx = (stats[Stat.ItemsIcon] as number | undefined) ?? 0;
    if (iconIdx > 0) {
        const icon = lookupImage(configstrings, iconIdx, layout.images);
        if (icon) {
            const base = icon.replace(/^.*\//, '').toLowerCase();
            const fromIcon = AQ2_ITEM_ICON_LABELS[base] ?? AQ2_ITEM_ICON_LABELS[icon];
            if (fromIcon) return fromIcon;
        }
    }

    const idx = (stats[Stat.SelectedItem] as number | undefined) ?? 0;
    if (idx < 1) return undefined;
    const name = lookupItem(configstrings, idx, layout.items);
    if (!name) return undefined;
    return AQ2_ITEM_LABELS[name];
}

function lookupCs(
    configstrings: Map<number, string> | Record<number, string>,
    index: number,
): string {
    if (configstrings instanceof Map) return configstrings.get(index) ?? '';
    return configstrings[index] ?? '';
}

function lookupModel(
    configstrings: Map<number, string> | Record<number, string>,
    gunindex: number,
    modelsBase: number,
): string {
    return lookupCs(configstrings, modelsBase + gunindex);
}

function lookupItem(
    configstrings: Map<number, string> | Record<number, string>,
    itemIndex: number,
    itemsBase: number,
): string {
    return lookupCs(configstrings, itemsBase + itemIndex);
}

function lookupImage(
    configstrings: Map<number, string> | Record<number, string>,
    imageIndex: number,
    imagesBase: number,
): string {
    return lookupCs(configstrings, imagesBase + imageIndex);
}
