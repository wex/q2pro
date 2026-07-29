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

export interface WeaponResolveInput {
    /** From entity skinnum>>8 when modelindex2===255; preferred. */
    weaponTypeNum?: number;
    /** player_state.gunindex; secondary via CS_MODELS. */
    gunindex?: number;
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
 * Prefer entity vwep typeNum; else match CS_MODELS[gunindex] path.
 * Returns typeNum or undefined if unknown.
 */
export function resolveWeaponTypeNum(
    input: WeaponResolveInput,
    configstrings: Map<number, string> | Record<number, string>,
): number | undefined {
    const fromEntity = input.weaponTypeNum;
    if (fromEntity != null && fromEntity > 0 && AQ2_WEAPON_LABELS[fromEntity]) {
        return fromEntity;
    }

    const gun = input.gunindex ?? 0;
    if (gun <= 0) return undefined;

    const path = lookupModel(configstrings, gun);
    if (!path) return undefined;

    const lower = path.toLowerCase();
    for (const { frag, typeNum } of VIEW_MODEL_TO_TYPE) {
        if (lower.includes(frag)) return typeNum;
    }
    return undefined;
}

export function resolveWeaponLabel(
    input: WeaponResolveInput,
    configstrings: Map<number, string> | Record<number, string>,
): string | undefined {
    const typeNum = resolveWeaponTypeNum(input, configstrings);
    return typeNum != null ? weaponLabel(typeNum) : undefined;
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
): string | undefined {
    if (!alive) return undefined;

    const iconIdx = (stats[Stat.ItemsIcon] as number | undefined) ?? 0;
    if (iconIdx > 0) {
        const icon = lookupImage(configstrings, iconIdx);
        if (icon) {
            const base = icon.replace(/^.*\//, '').toLowerCase();
            const fromIcon = AQ2_ITEM_ICON_LABELS[base] ?? AQ2_ITEM_ICON_LABELS[icon];
            if (fromIcon) return fromIcon;
        }
    }

    const idx = (stats[Stat.SelectedItem] as number | undefined) ?? 0;
    if (idx < 1) return undefined;
    const name = lookupItem(configstrings, idx);
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
): string {
    return lookupCs(configstrings, CS_MODELS_EXT + gunindex)
        || lookupCs(configstrings, CS_MODELS_OLD + gunindex)
        || '';
}

function lookupItem(
    configstrings: Map<number, string> | Record<number, string>,
    itemIndex: number,
): string {
    return lookupCs(configstrings, CS_ITEMS_EXT + itemIndex)
        || lookupCs(configstrings, CS_ITEMS_OLD + itemIndex)
        || '';
}

function lookupImage(
    configstrings: Map<number, string> | Record<number, string>,
    imageIndex: number,
): string {
    return lookupCs(configstrings, CS_IMAGES_EXT + imageIndex)
        || lookupCs(configstrings, CS_IMAGES_OLD + imageIndex)
        || '';
}
