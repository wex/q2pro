import {
    AQ2_WEAPON_LABELS,
    CS_MODELS_EXT,
    CS_MODELS_OLD,
    extractAmmo,
    isAlive,
    isScoped,
    resolveWeaponLabel,
    resolveWeaponTypeNum,
    weaponLabel,
} from '../src/player-loadout';
import { PmType, Stat } from '../src/protocol';

describe('player-loadout', () => {
    test('weaponLabel covers AQ2 typeNums', () => {
        expect(weaponLabel(1)).toBe('MK23');
        expect(weaponLabel(6)).toBe('SSG');
        expect(weaponLabel(23)).toBe('Grapple');
        expect(weaponLabel(99)).toBeUndefined();
    });

    test('resolveWeaponTypeNum prefers entity typeNum over gunindex', () => {
        const cs = new Map<number, string>();
        cs.set(CS_MODELS_OLD + 5, 'models/weapons/v_m4/tris.md2');
        expect(resolveWeaponTypeNum({ weaponTypeNum: 2, gunindex: 5 }, cs)).toBe(2);
        expect(resolveWeaponLabel({ weaponTypeNum: 2, gunindex: 5 }, cs)).toBe('MP5');
    });

    test('resolveWeaponTypeNum falls back to CS_MODELS path', () => {
        const cs: Record<number, string> = {};
        cs[CS_MODELS_EXT + 7] = 'models/weapons/v_sniper/tris.md2';
        expect(resolveWeaponTypeNum({ gunindex: 7 }, cs)).toBe(6);
        expect(resolveWeaponLabel({ gunindex: 7 }, cs)).toBe('SSG');
    });

    test('resolveWeaponTypeNum returns undefined when gunindex is 0', () => {
        expect(resolveWeaponTypeNum({ gunindex: 0 }, {})).toBeUndefined();
        expect(resolveWeaponTypeNum({ weaponTypeNum: 0 }, {})).toBeUndefined();
    });

    test('isAlive requires PM_NORMAL and health > 0', () => {
        expect(isAlive(PmType.Normal, 100)).toBe(true);
        expect(isAlive(PmType.Normal, 0)).toBe(false);
        expect(isAlive(PmType.Dead, 100)).toBe(false);
        expect(isAlive(PmType.Spectator, 50)).toBe(false);
    });

    test('extractAmmo returns undefined when dead', () => {
        const stats = new Int16Array(32);
        stats[Stat.Ammo] = 12;
        stats[Stat.Clip] = 3;
        stats[Stat.Grenades] = 1;
        expect(extractAmmo(stats, false)).toBeUndefined();
        expect(extractAmmo(stats, true)).toEqual({ ammo: 12, clips: 3, grenades: 1 });
    });

    test('isScoped detects fov or sniper icon', () => {
        expect(isScoped(90, 0)).toBe(false);
        expect(isScoped(45, 0)).toBe(true);
        expect(isScoped(90, 12)).toBe(true);
    });

    test('AQ2_WEAPON_LABELS keys match known set', () => {
        expect(Object.keys(AQ2_WEAPON_LABELS).map(Number).sort((a, b) => a - b)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 23,
        ]);
    });
});
