import { MvdFrameParser, PlayerState, TempEntityEvent } from './frame';
import { TempEntityType } from './protocol';

/**
 * Damage FX event broadcast to the UI. Emitted when a damage-on-player
 * TempEntity lands close to a live player; the UI renders coloured
 * particles + a pulse ring on that player.
 *
 * `kind`:
 *   - `'blood'`  — `TE_BLOOD`, `TE_GREENBLOOD`, `TE_MOREBLOOD` (flesh hit).
 *   - `'sparks'` — `TE_BULLET_SPARKS`, `TE_SPARKS` (armor / vest absorb).
 */
export interface DamageEvent {
    victim: number;
    kind: 'blood' | 'sparks';
    position: [number, number, number];
    t: number;
}

/** Blood TEs: flesh hits. */
const BLOOD_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.Blood,
    TempEntityType.GreenBlood,
    TempEntityType.MoreBlood,
]);

/** Spark TEs: armor / kevlar absorbs. Wall-hit sparks are rejected by the
 *  nearest-player distance cap in `handleTE`. */
const SPARKS_TYPES: ReadonlySet<number> = new Set<number>([
    TempEntityType.BulletSparks,
    TempEntityType.Sparks,
]);

export interface CombatFxOptions {
    /** Max distance (world units) from a TE position to a live player for
     *  that player to be treated as the victim. Tight enough to reject
     *  wall-impact sparks (e.g. knife-on-wall) from spuriously painting
     *  nearby players. Defaults to 80. */
    victimMaxDist?: number;
    /** Injectable clock; defaults to Date.now. */
    now?: () => number;
}

/**
 * Pure resolver that maps damage-on-player TempEntity events to
 * `DamageEvent`s by nearest-player attribution. No I/O, no SSE dependency.
 */
export class CombatFxResolver {
    private readonly victimMaxDist: number;
    private readonly now: () => number;

    private players: ReadonlyMap<number, PlayerState> | null = null;

    constructor(opts: CombatFxOptions = {}) {
        this.victimMaxDist = opts.victimMaxDist ?? 80;
        this.now = opts.now ?? Date.now;
    }

    /** Hold a read-only reference to the live player map. */
    notePlayers(map: ReadonlyMap<number, PlayerState>): void {
        this.players = map;
    }

    /** Clear the player reference. */
    reset(): void {
        this.players = null;
    }

    /**
     * Convert a TempEntity event into a `DamageEvent` with a resolved victim,
     * or null if the TE type is not a damage-on-player event or if no live
     * player is within `victimMaxDist` of the TE position.
     */
    handleTE(ev: TempEntityEvent): DamageEvent | null {
        if (!ev.position) return null;

        let kind: 'blood' | 'sparks';
        if (BLOOD_TYPES.has(ev.type)) kind = 'blood';
        else if (SPARKS_TYPES.has(ev.type)) kind = 'sparks';
        else return null;

        const victim = this.findNearestPlayer(ev.position);
        if (victim === undefined) return null;

        return {
            victim,
            kind,
            position: ev.position,
            t: this.now(),
        };
    }

    // ── internals ───────────────────────────────────────────────────

    private findNearestPlayer(impact: [number, number, number]): number | undefined {
        if (!this.players) return undefined;
        let best: number | undefined;
        let bestDist = Infinity;
        for (const p of this.players.values()) {
            if (!p.inUse) continue;
            const world = MvdFrameParser.originToWorld(p.origin);
            const dx = world[0] - impact[0];
            const dy = world[1] - impact[1];
            const dz = world[2] - impact[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < bestDist) {
                bestDist = d;
                best = p.number;
            }
        }
        if (best === undefined) return undefined;
        if (bestDist > this.victimMaxDist) return undefined;
        return best;
    }
}
