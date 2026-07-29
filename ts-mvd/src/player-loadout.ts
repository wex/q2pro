/**
 * AQ2/TNG player loadout helpers for MVD streams.
 *
 * Resolves weapon id/label and ammo from raw playerstate + entity signals.
 * Label resolution needs configstrings (CS_MODELS); call from app.ts, not
 * from the frame parser. See doc/fable-search.md §4–§5 and doc/player-loadout.md.
 */

import { PmType, Stat } from './protocol';

/** Configstring bases for CS_MODELS (classic vs MVF_EXTLIMITS). */
export const CS_MODELS_OLD = 32;
export const CS_MODELS_EXT = 62;

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

function lookupModel(
    configstrings: Map<number, string> | Record<number, string>,
    gunindex: number,
): string {
    const get = (i: number): string => {
        if (configstrings instanceof Map) return configstrings.get(i) ?? '';
        return configstrings[i] ?? '';
    };
    // Prefer extended layout when present; fall back to classic.
    return get(CS_MODELS_EXT + gunindex) || get(CS_MODELS_OLD + gunindex) || '';
}
