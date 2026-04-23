import { ShotTraceResolver } from '../src/shot-trace';
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
    };
}

function te(
    type: number,
    position?: [number, number, number],
    endPosition?: [number, number, number],
): TempEntityEvent {
    return { type, position, endPosition };
}

describe('ShotTraceResolver', () => {
    describe('two-point TEs', () => {
        test('resolves nearest-to-muzzle shooter', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [10, 10, 0]));
            players.set(2, makePlayer(2, [200, 200, 0]));
            r.notePlayers(players);

            const shot = r.handleTE(te(TempEntityType.RailTrail, [12, 10, 0], [500, 500, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.type).toBe(TempEntityType.RailTrail);
            expect(shot!.wireStart).toEqual([12, 10, 0]);
            expect(shot!.wireEnd).toEqual([500, 500, 0]);
            expect(shot!.shooter).toBe(1);
            expect(shot!.t).toBe(1000);
        });

        test('ignores players whose nearest distance exceeds MUZZLE_MAX_DIST', () => {
            const r = new ShotTraceResolver({ muzzleMaxDist: 50 });
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [1000, 0, 0]));
            r.notePlayers(players);

            const shot = r.handleTE(te(TempEntityType.BfgLaser, [0, 0, 0], [10, 0, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.shooter).toBeUndefined();
            expect(shot!.wireStart).toEqual([0, 0, 0]);
            expect(shot!.wireEnd).toEqual([10, 0, 0]);
        });

        test('returns null when endPosition is missing', () => {
            const r = new ShotTraceResolver();
            expect(r.handleTE(te(TempEntityType.RailTrail, [0, 0, 0]))).toBeNull();
        });

        test('skips players marked inUse=false', () => {
            const r = new ShotTraceResolver();
            const players = new Map<number, PlayerState>();
            const dead = makePlayer(1, [0, 0, 0]);
            dead.inUse = false;
            players.set(1, dead);
            players.set(2, makePlayer(2, [100, 0, 0]));
            r.notePlayers(players);

            const shot = r.handleTE(te(TempEntityType.BubbleTrail, [0, 0, 0], [1, 0, 0]));
            expect(shot!.shooter).toBe(2);
        });
    });

    describe('single-point bullet TEs', () => {
        test('binds shooter from most recent hit within window', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ hitWindowMs: 250, now: () => t });
            r.noteHit(7, 900);
            r.noteHit(9, 950);

            const shot = r.handleTE(te(TempEntityType.Gunshot, [50, 50, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.shooter).toBe(9);
            expect(shot!.wireStart).toEqual([50, 50, 0]);
            expect(shot!.wireEnd).toBeUndefined();
        });

        test('returns shooter=undefined when no recent hit', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ hitWindowMs: 250, now: () => t });
            const shot = r.handleTE(te(TempEntityType.Shotgun, [0, 0, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.shooter).toBeUndefined();
        });

        test('ignores hits older than HIT_WINDOW_MS', () => {
            let t = 2000;
            const r = new ShotTraceResolver({ hitWindowMs: 250, now: () => t });
            r.noteHit(3, 1000); // 1s old
            const shot = r.handleTE(te(TempEntityType.BulletSparks, [0, 0, 0]));
            expect(shot!.shooter).toBeUndefined();
        });

        test('covers all bullet TE types', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            r.noteHit(5, 1000);
            for (const type of [
                TempEntityType.Gunshot,
                TempEntityType.Shotgun,
                TempEntityType.BulletSparks,
                TempEntityType.Sparks,
                TempEntityType.Blaster,
            ]) {
                r.noteHit(5, 1000);
                const shot = r.handleTE(te(type, [0, 0, 0]));
                expect(shot).not.toBeNull();
                expect(shot!.shooter).toBe(5);
            }
        });

        test('returns null when position is missing', () => {
            const r = new ShotTraceResolver();
            expect(r.handleTE({ type: TempEntityType.Gunshot })).toBeNull();
        });

        test('blaster wall impact resolves shooter from recent hit', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ hitWindowMs: 250, now: () => t });
            r.noteHit(4, 900);
            const shot = r.handleTE(te(TempEntityType.Blaster, [10, 20, 30]));
            expect(shot).not.toBeNull();
            expect(shot!.type).toBe(TempEntityType.Blaster);
            expect(shot!.shooter).toBe(4);
            expect(shot!.wireStart).toEqual([10, 20, 30]);
            expect(shot!.wireEnd).toBeUndefined();
        });

        test('blaster wall impact without recent hit has no shooter', () => {
            let t = 2000;
            const r = new ShotTraceResolver({ hitWindowMs: 250, now: () => t });
            const shot = r.handleTE(te(TempEntityType.Blaster, [0, 0, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.shooter).toBeUndefined();
        });
    });

    describe('unhandled TE types', () => {
        test('returns null for non-shot TEs', () => {
            const r = new ShotTraceResolver();
            r.notePlayers(new Map());
            for (const type of [
                TempEntityType.Explosion1,
                TempEntityType.RocketExpl,
                TempEntityType.Blood,
                TempEntityType.GreenBlood,
                TempEntityType.BfgExplosion,
            ]) {
                expect(r.handleTE(te(type, [0, 0, 0]))).toBeNull();
            }
        });
    });

    describe('muzzleflash correlation', () => {
        test('TE_BLOOD draws shooter → blood from recent muzzleflash', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ muzzleFlashWindowMs: 200, now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(3, makePlayer(3, [10, 20, 0])); // clientNum 3 = edict 4
            r.notePlayers(players);

            r.noteMuzzleFlash(4, 1000); // entity 4 → clientNum 3

            const shot = r.handleTE(te(TempEntityType.Blood, [500, 600, 0]));
            expect(shot).not.toBeNull();
            expect(shot!.type).toBe(TempEntityType.Blood);
            expect(shot!.shooter).toBe(3);
            expect(shot!.wireStart).toEqual([10, 20, 0]);
            expect(shot!.wireEnd).toEqual([500, 600, 0]);
        });

        test('TE_BLOOD without a recent muzzleflash is dropped', () => {
            const r = new ShotTraceResolver();
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            const shot = r.handleTE(te(TempEntityType.Blood, [1, 2, 3]));
            expect(shot).toBeNull();
        });

        test('TE_BLOOD beyond the muzzleflash window is dropped', () => {
            let t = 5000;
            const r = new ShotTraceResolver({ muzzleFlashWindowMs: 200, now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);

            r.noteMuzzleFlash(1, 4000); // 1s ago, window is 200ms
            expect(r.handleTE(te(TempEntityType.Blood, [1, 2, 3]))).toBeNull();
        });

        test('muzzleflash attribution covers TE_GREENBLOOD and TE_MOREBLOOD', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(2, makePlayer(2, [0, 0, 0]));
            r.notePlayers(players);

            for (const type of [TempEntityType.GreenBlood, TempEntityType.MoreBlood]) {
                r.noteMuzzleFlash(3, 1000); // entity 3 → clientNum 2
                const shot = r.handleTE(te(type, [100, 0, 0]));
                expect(shot).not.toBeNull();
                expect(shot!.shooter).toBe(2);
                expect(shot!.wireEnd).toEqual([100, 0, 0]);
            }
        });

        test('bullet TEs prefer muzzleflash over hit-event attacker', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            r.noteHit(5, 990);       // hit print → client 5
            r.noteMuzzleFlash(8, 995); // entity 8 → client 7

            const shot = r.handleTE(te(TempEntityType.Gunshot, [50, 50, 0]));
            expect(shot!.shooter).toBe(7);
        });

        test('bullet TEs fall back to hit-event attacker when no muzzleflash', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            r.noteHit(5, 990);
            const shot = r.handleTE(te(TempEntityType.Gunshot, [50, 50, 0]));
            expect(shot!.shooter).toBe(5);
        });

        test('reset() clears flashes too', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(0, makePlayer(0, [0, 0, 0]));
            r.notePlayers(players);
            r.noteMuzzleFlash(1, 1000);
            r.reset();
            r.notePlayers(players);
            expect(r.handleTE(te(TempEntityType.Blood, [1, 2, 3]))).toBeNull();
        });
    });

    describe('handleHit (synthetic)', () => {
        test('produces two-point attacker→victim shot from player origins', () => {
            let t = 5000;
            const r = new ShotTraceResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [100, 200, 0]));
            players.set(2, makePlayer(2, [500, 600, 0]));
            r.notePlayers(players);

            const shot = r.handleHit(1, 2);
            expect(shot).not.toBeNull();
            expect(shot!.type).toBe(TempEntityType.Gunshot);
            expect(shot!.shooter).toBe(1);
            expect(shot!.wireStart).toEqual([100, 200, 0]);
            expect(shot!.wireEnd).toEqual([500, 600, 0]);
            expect(shot!.t).toBe(5000);
        });

        test('returns null when attacker is missing', () => {
            const r = new ShotTraceResolver();
            const players = new Map<number, PlayerState>();
            players.set(2, makePlayer(2, [0, 0, 0]));
            r.notePlayers(players);
            expect(r.handleHit(1, 2)).toBeNull();
        });

        test('returns null when victim is missing', () => {
            const r = new ShotTraceResolver();
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [0, 0, 0]));
            r.notePlayers(players);
            expect(r.handleHit(1, 2)).toBeNull();
        });

        test('returns null when victim is marked inUse=false', () => {
            const r = new ShotTraceResolver();
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [0, 0, 0]));
            const dead = makePlayer(2, [1, 1, 1]);
            dead.inUse = false;
            players.set(2, dead);
            r.notePlayers(players);
            expect(r.handleHit(1, 2)).toBeNull();
        });

        test('returns null when players reference has not been set', () => {
            const r = new ShotTraceResolver();
            expect(r.handleHit(1, 2)).toBeNull();
        });
    });

    describe('reset()', () => {
        test('clears recent hits and player reference', () => {
            let t = 1000;
            const r = new ShotTraceResolver({ now: () => t });
            const players = new Map<number, PlayerState>();
            players.set(1, makePlayer(1, [0, 0, 0]));
            r.notePlayers(players);
            r.noteHit(1, 1000);

            r.reset();

            const shot1 = r.handleTE(te(TempEntityType.Gunshot, [0, 0, 0]));
            expect(shot1!.shooter).toBeUndefined();
            const shot2 = r.handleTE(te(TempEntityType.RailTrail, [0, 0, 0], [100, 0, 0]));
            expect(shot2!.shooter).toBeUndefined();
        });
    });
});
