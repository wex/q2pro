import { CombatFxResolver } from '../src/combat-fx';
import { PlayerState, TempEntityEvent } from '../src/frame';
import { TempEntityType } from '../src/protocol';

function makePlayer(number: number, worldXyz: [number, number, number]): PlayerState {
    // PlayerState.origin is raw (world * 8).
    return {
        number,
        inUse: true,
        pmType: 0,
        origin: [worldXyz[0] * 8, worldXyz[1] * 8, worldXyz[2] * 8],
        viewangles: [0, 0, 0],
        viewoffset: [0, 0, 0],
        fov: 90,
        gunindex: 0,
        rdflags: 0,
        frags: 0,
        stats: new Int16Array(32),
        isMvdDummy: false,
    };
}

function te(type: number, position?: [number, number, number]): TempEntityEvent {
    return { type, position };
}

describe('CombatFxResolver', () => {
    describe('blood TEs', () => {
        test('TE_BLOOD near a player emits kind=blood with that victim', () => {
            let t = 5000;
            const r = new CombatFxResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [100, 100, 0]));
            players.set(2, makePlayer(2, [900, 900, 0]));
            r.notePlayers(players);

            const dmg = r.handleTE(te(TempEntityType.Blood, [110, 100, 0]));
            expect(dmg).not.toBeNull();
            expect(dmg!.kind).toBe('blood');
            expect(dmg!.victim).toBe(1);
            expect(dmg!.position).toEqual([110, 100, 0]);
            expect(dmg!.t).toBe(5000);
        });

        test('TE_GREENBLOOD and TE_MOREBLOOD also classify as blood', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            for (const type of [TempEntityType.GreenBlood, TempEntityType.MoreBlood]) {
                const dmg = r.handleTE(te(type, [10, 0, 0]));
                expect(dmg).not.toBeNull();
                expect(dmg!.kind).toBe('blood');
                expect(dmg!.victim).toBe(0);
            }
        });
    });

    describe('sparks TEs', () => {
        test('TE_BULLET_SPARKS near a player emits kind=sparks', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(3, makePlayer(3, [0, 0, 0]));
            r.notePlayers(players);

            const dmg = r.handleTE(te(TempEntityType.BulletSparks, [5, 5, 0]));
            expect(dmg).not.toBeNull();
            expect(dmg!.kind).toBe('sparks');
            expect(dmg!.victim).toBe(3);
        });

        test('TE_SPARKS near a player (kevlar absorb) emits kind=sparks', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(4, makePlayer(4, [0, 0, 0]));
            r.notePlayers(players);

            const dmg = r.handleTE(te(TempEntityType.Sparks, [20, 0, 0]));
            expect(dmg!.kind).toBe('sparks');
        });
    });

    describe('distance cap', () => {
        test('sparks far from any player (wall hit) is dropped', () => {
            const r = new CombatFxResolver({ victimMaxDist: 80 });
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            // 200 units away → outside default 80u cap.
            expect(r.handleTE(te(TempEntityType.Sparks, [200, 0, 0]))).toBeNull();
            expect(r.handleTE(te(TempEntityType.BulletSparks, [0, 200, 0]))).toBeNull();
            expect(r.handleTE(te(TempEntityType.Blood, [0, 0, 200]))).toBeNull();
        });

        test('victimMaxDist option is honoured', () => {
            const r = new CombatFxResolver({ victimMaxDist: 10 });
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            // 20u away → outside the 10u cap, dropped.
            expect(r.handleTE(te(TempEntityType.Blood, [20, 0, 0]))).toBeNull();
            // 5u away → inside, accepted.
            expect(r.handleTE(te(TempEntityType.Blood, [5, 0, 0]))).not.toBeNull();
        });

        test('nearest player wins when multiple are within the cap', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [0, 0, 0]));
            players.set(2, makePlayer(2, [30, 0, 0]));
            r.notePlayers(players);

            const dmg = r.handleTE(te(TempEntityType.Blood, [25, 0, 0]));
            expect(dmg!.victim).toBe(2);
        });

        test('inactive players are skipped', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            const dead = makePlayer(1, [0, 0, 0]);
            dead.inUse = false;
            players.set(1, dead);
            players.set(2, makePlayer(2, [40, 0, 0]));
            r.notePlayers(players);

            const dmg = r.handleTE(te(TempEntityType.Blood, [10, 0, 0]));
            expect(dmg!.victim).toBe(2);
        });
    });

    describe('unhandled TE types', () => {
        test('explosions, rail trails, blaster, gunshot, shotgun are ignored', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            for (const type of [
                TempEntityType.Gunshot,
                TempEntityType.Shotgun,
                TempEntityType.Blaster,
                TempEntityType.RailTrail,
                TempEntityType.BfgLaser,
                TempEntityType.BubbleTrail,
                TempEntityType.Explosion1,
                TempEntityType.RocketExpl,
                TempEntityType.GrenadeExpl,
            ]) {
                expect(r.handleTE(te(type, [0, 0, 0]))).toBeNull();
            }
        });

        test('TE with no position is ignored', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);
            expect(r.handleTE({ type: TempEntityType.Blood })).toBeNull();
        });
    });

    describe('reset()', () => {
        test('clears the player reference', () => {
            const r = new CombatFxResolver();
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);
            r.reset();
            expect(r.handleTE(te(TempEntityType.Blood, [0, 0, 0]))).toBeNull();
        });
    });
});
