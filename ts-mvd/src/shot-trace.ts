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

/** Single-point bullet TEs. Shooter is resolved from recent hit events. */
const BULLET_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.Gunshot,
    TempEntityType.Shotgun,
    TempEntityType.BulletSparks,
    TempEntityType.Sparks,
]);

export interface ShotTraceOptions {
    /** Max distance (world units) between muzzle and a player to count as shooter. */
    muzzleMaxDist?: number;
    /** Hit-event correlation window (ms) for single-point bullet TEs. */
    hitWindowMs?: number;
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
    private readonly now: () => number;

    private players: ReadonlyMap<number, PlayerState> | null = null;
    private readonly recentHits: { attacker: number; t: number }[] = [];

    constructor(opts: ShotTraceOptions = {}) {
        this.muzzleMaxDist = opts.muzzleMaxDist ?? 4000;
        this.hitWindowMs = opts.hitWindowMs ?? 250;
        this.now = opts.now ?? Date.now;
    }

    /** Record a hit event (attacker clientNum) for later bullet-TE correlation. */
    noteHit(attacker: number, t: number = this.now()): void {
        this.recentHits.push({ attacker, t });
        this.evictOldHits(t);
    }

    /**
     * Provide a live reference to the player map. The resolver holds the
     * reference (read-only); subsequent updates through the same map are
     * visible without additional calls.
     */
    notePlayers(map: ReadonlyMap<number, PlayerState>): void {
        this.players = map;
    }

    /** Clear recent hits and the player reference. */
    reset(): void {
        this.players = null;
        this.recentHits.length = 0;
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

        return null;
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
        this.evictOldHits(now);
        if (this.recentHits.length === 0) return undefined;
        // Most recent wins.
        return this.recentHits[this.recentHits.length - 1].attacker;
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
