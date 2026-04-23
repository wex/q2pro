import { MvdFrameParser, PlayerState, TempEntityEvent } from './frame';
import { TempEntityType } from './protocol';

/**
 * Resolved shot event broadcast to the UI. Carries the wire positions
 * verbatim plus an optional `shooter` clientNum resolved by the server.
 *
 * Two-point TEs (rail, BFG laser, hyperblaster, bubble trail) have both
 * `wireStart` (muzzle) and `wireEnd` (impact). Single-point bullet TEs
 * (gunshot, shotgun, bullet sparks, sparks) have only `wireStart` (impact);
 * the client is expected to draw `shooter` → `wireStart` when it can.
 */
export interface ShotEvent {
    type: number;
    wireStart: [number, number, number];
    wireEnd?: [number, number, number];
    /** Resolved shooter clientNum, when known. */
    shooter?: number;
    /** Server-side timestamp (ms, performance.now or Date.now semantics). */
    t: number;
}

/** Two-point weapon TEs whose wire frame carries both endpoints. */
const TWO_POINT_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.RailTrail,
    TempEntityType.BlueHyper,
    TempEntityType.BfgLaser,
    TempEntityType.BubbleTrail,
]);

/** Single-point bullet TEs (wall/prop impacts). Shooter is resolved from a
 *  recent muzzleflash or hit event. */
const BULLET_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.Gunshot,
    TempEntityType.Shotgun,
    TempEntityType.BulletSparks,
    TempEntityType.Sparks,
    TempEntityType.Blaster,
]);

/** Single-point blood TEs (player impacts). AQ2 `fire_lead`/`fire_lead_ap`
 *  writes these instead of a bullet TE when the shot strikes a player.
 *  Shooter is resolved from the most recent muzzleflash within the window. */
const BLOOD_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.Blood,
    TempEntityType.GreenBlood,
    TempEntityType.MoreBlood,
]);

export interface ShotTraceOptions {
    /** Max distance (world units) between muzzle and a player to count as shooter. */
    muzzleMaxDist?: number;
    /** Hit-event correlation window (ms) for single-point bullet TEs. */
    hitWindowMs?: number;
    /** Muzzleflash correlation window (ms) for single-point / blood TEs.
     *  Hitscan weapons fire in the same tick the TE is emitted, so this can
     *  be tight (default 200 ms). Kept shorter than `hitWindowMs` so rocket
     *  / grenade radius blood doesn't latch onto an earlier bullet shooter. */
    muzzleFlashWindowMs?: number;
    /** Injectable clock; defaults to Date.now. */
    now?: () => number;
}

/**
 * Correlates MVD temp-entity events with live player state and recent hit
 * events to produce `ShotEvent`s with a resolved shooter clientNum. Pure
 * module: no I/O, no SSE dependency.
 */
export class ShotTraceResolver {
    private readonly muzzleMaxDist: number;
    private readonly hitWindowMs: number;
    private readonly muzzleFlashWindowMs: number;
    private readonly now: () => number;

    private players: ReadonlyMap<number, PlayerState> | null = null;
    private readonly recentHits: { attacker: number; t: number }[] = [];
    private readonly recentFlashes: { attacker: number; t: number }[] = [];

    constructor(opts: ShotTraceOptions = {}) {
        this.muzzleMaxDist = opts.muzzleMaxDist ?? 4000;
        this.hitWindowMs = opts.hitWindowMs ?? 250;
        this.muzzleFlashWindowMs = opts.muzzleFlashWindowMs ?? 200;
        this.now = opts.now ?? Date.now;
    }

    /** Record a hit event (attacker clientNum) for later bullet-TE correlation. */
    noteHit(attacker: number, t: number = this.now()): void {
        this.recentHits.push({ attacker, t });
        this.evictOldHits(t);
    }

    /**
     * Record a muzzleflash event. `entity` is the shooter's edict number
     * (1..max_edicts); the attacker's clientNum is `entity - 1`. Hitscan
     * weapons fire, emit the TE, and send the muzzleflash within the same
     * server tick, so this is the most reliable attribution source and does
     * not depend on unicast prints (which Q2Pro filters by default via
     * `sv_mvd_nomsgs`).
     */
    noteMuzzleFlash(entity: number, t: number = this.now()): void {
        if (entity <= 0) return;
        this.recentFlashes.push({ attacker: entity - 1, t });
        this.evictOldFlashes(t);
    }

    /**
     * Provide a live reference to the player map. The resolver holds the
     * reference (read-only); subsequent updates through the same map are
     * visible without additional calls.
     */
    notePlayers(map: ReadonlyMap<number, PlayerState>): void {
        this.players = map;
    }

    /** Clear recent hits, flashes, and the player reference. */
    reset(): void {
        this.players = null;
        this.recentHits.length = 0;
        this.recentFlashes.length = 0;
    }

    /**
     * Convert a TempEntity event into a ShotEvent with a resolved shooter,
     * or null if the TE type is not a shot we visualize.
     */
    handleTE(ev: TempEntityEvent): ShotEvent | null {
        const now = this.now();

        if (TWO_POINT_TYPES.has(ev.type)) {
            if (!ev.position || !ev.endPosition) return null;
            const shooter = this.findNearestPlayer(ev.position);
            return {
                type: ev.type,
                wireStart: ev.position,
                wireEnd: ev.endPosition,
                shooter,
                t: now,
            };
        }

        if (BULLET_TYPES.has(ev.type)) {
            if (!ev.position) return null;
            const shooter = this.findRecentAttacker(now);
            return {
                type: ev.type,
                wireStart: ev.position,
                shooter,
                t: now,
            };
        }

        if (BLOOD_TYPES.has(ev.type)) {
            if (!ev.position) return null;
            // Player-hit blood TEs: attribute via the most recent muzzleflash.
            // Unicast "You hit X" prints are filtered from MVD streams by
            // default (sv_mvd_nomsgs=1 in Q2Pro), so `noteHit` is not a
            // reliable fallback here. Emit a two-point line from the
            // shooter's current origin to the blood impact.
            const shooter = this.findRecentFlash(now);
            if (shooter === undefined) return null;
            const start = this.playerWorldOrigin(shooter);
            if (!start) return null;
            return {
                type: ev.type,
                wireStart: start,
                wireEnd: ev.position,
                shooter,
                t: now,
            };
        }

        return null;
    }

    /**
     * Build a synthetic two-point shot from a hit event. Used for bullet
     * weapons (sniper / pistols / MP5 / M4 / HC) where AQ2's fire_lead emits
     * no bullet TE when the round strikes a player — `T_Damage` writes
     * `TE_BLOOD` instead, which we don't visualize. Callers supply both
     * clientNums; this method resolves their current world-space origins
     * from the live player map.
     *
     * Returns null if either player is missing, inactive, or the player
     * reference has not been set. The returned `ShotEvent` carries
     * `TempEntityType.Gunshot` as a generic single-point id plus both
     * `wireStart` and `wireEnd`; downstream consumers should treat any
     * `wireEnd`-bearing event as a two-point line.
     */
    handleHit(attackerClientNum: number, victimClientNum: number): ShotEvent | null {
        if (!this.players) return null;
        const attackerOrigin = this.playerWorldOrigin(attackerClientNum);
        if (!attackerOrigin) return null;
        const victimOrigin = this.playerWorldOrigin(victimClientNum);
        if (!victimOrigin) return null;
        return {
            type: TempEntityType.Gunshot,
            wireStart: attackerOrigin,
            wireEnd: victimOrigin,
            shooter: attackerClientNum,
            t: this.now(),
        };
    }

    // ── internals ───────────────────────────────────────────────────

    private evictOldHits(now: number): void {
        const cutoff = now - this.hitWindowMs;
        let write = 0;
        for (let read = 0; read < this.recentHits.length; read++) {
            const h = this.recentHits[read];
            if (h.t >= cutoff) {
                if (write !== read) this.recentHits[write] = h;
                write++;
            }
        }
        this.recentHits.length = write;
    }

    private findRecentAttacker(now: number): number | undefined {
        // Prefer muzzleflash (multicast, always present) over hit prints
        // (unicast, filtered out by sv_mvd_nomsgs=1 by default in Q2Pro).
        const flash = this.findRecentFlash(now);
        if (flash !== undefined) return flash;
        this.evictOldHits(now);
        if (this.recentHits.length === 0) return undefined;
        return this.recentHits[this.recentHits.length - 1].attacker;
    }

    private findRecentFlash(now: number): number | undefined {
        this.evictOldFlashes(now);
        if (this.recentFlashes.length === 0) return undefined;
        return this.recentFlashes[this.recentFlashes.length - 1].attacker;
    }

    private evictOldFlashes(now: number): void {
        const cutoff = now - this.muzzleFlashWindowMs;
        let write = 0;
        for (let read = 0; read < this.recentFlashes.length; read++) {
            const h = this.recentFlashes[read];
            if (h.t >= cutoff) {
                if (write !== read) this.recentFlashes[write] = h;
                write++;
            }
        }
        this.recentFlashes.length = write;
    }

    private playerWorldOrigin(clientNum: number): [number, number, number] | undefined {
        if (!this.players) return undefined;
        const p = this.players.get(clientNum);
        if (!p || !p.inUse) return undefined;
        return MvdFrameParser.originToWorld(p.origin);
    }

    private findNearestPlayer(muzzle: [number, number, number]): number | undefined {
        if (!this.players) return undefined;
        let best: number | undefined;
        let bestDist = Infinity;
        for (const p of this.players.values()) {
            if (!p.inUse) continue;
            const world = MvdFrameParser.originToWorld(p.origin);
            const dx = world[0] - muzzle[0];
            const dy = world[1] - muzzle[1];
            const dz = world[2] - muzzle[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < bestDist) {
                bestDist = d;
                best = p.number;
            }
        }
        if (best === undefined) return undefined;
        if (bestDist > this.muzzleMaxDist) return undefined;
        return best;
    }
}
