/**
 * Per-round match statistics for MVD streams (AQ2).
 *
 * Aggregation layer fed by `MvdFrameParser` events — obituaries give kill
 * attribution, `onDeath` gives authoritative deaths (STAT_HEALTH → 0), and
 * `onHit`/`onHitTaken` add hit-location tracking. Round boundaries are
 * detected heuristically from layout/centerprint text since there is no
 * protocol-level round marker; unmatched streams simply accumulate in a
 * single round. See doc/session-stats.md.
 *
 * Pure module — no I/O, injectable clock.
 */

export interface PlayerRoundStats {
    kills: number;
    deaths: number;
    /** Hits dealt (from `onHit` unicast prints). */
    hits: number;
    /** Hits received (from `onHitTaken` unicast prints). */
    hitsTaken: number;
    /** Dealt hits by body location: head/chest/stomach/legs/body/''. */
    hitsByLocation: Record<string, number>;
    /** Kills dealt by weapon token (obituary template; 'unknown' when null). */
    weaponsUsed: Record<string, number>;
}

export interface RoundStats {
    index: number;
    startedAt: number;
    players: Map<string, PlayerRoundStats>;
    /** Kills by weapon token, aggregated over the round's players. */
    weaponKills: Record<string, number>;
}

export interface StatsSnapshot {
    rounds: Array<{
        index: number;
        startedAt: number;
        players: Record<string, PlayerRoundStats>;
        weaponKills: Record<string, number>;
    }>;
    totals: {
        players: Record<string, PlayerRoundStats>;
        weaponKills: Record<string, number>;
    };
}

export interface StatsTrackerOptions {
    /** Resolve a clientNum to a player name (playerskin configstring). */
    namer?: (clientNum: number) => string | undefined;
    /** Texts matching any pattern open a new round. */
    roundPatterns?: RegExp[];
    /** Retained completed rounds + the live one (default 64). */
    maxRounds?: number;
    now?: () => number;
}

/**
 * Heuristic round-boundary patterns. AQ2 has no protocol marker for round
 * start/end; its mods signal via centerprints ("FIGHT!", "Round N") and
 * end-of-round scoreboard layouts. These patterns are deliberately narrow —
 * false positives only split stats, they never corrupt them. Configurable
 * via `StatsTrackerOptions.roundPatterns`.
 */
export const DEFAULT_ROUND_PATTERNS: readonly RegExp[] = [
    /^fight!*$/i,
    /^round\s+\d+/i,
    /round begins/i,
    /match start/i,
    /timelimit/i,
];

const MAX_ROUNDS_DEFAULT = 64;
const UNKNOWN_WEAPON = 'unknown';

export interface StatsEventSource {
    // Structural typings decoupled from frame.ts so the tracker stays
    // testable without the parser.
}

export class StatsTracker {
    private readonly namer: (clientNum: number) => string | undefined;
    private readonly roundPatterns: RegExp[];
    private readonly maxRounds: number;
    private readonly now: () => number;

    private rounds: RoundStats[] = [];
    private roundIndex = 0;

    constructor(opts: StatsTrackerOptions = {}) {
        this.namer = opts.namer ?? (() => undefined);
        this.roundPatterns = opts.roundPatterns ?? [...DEFAULT_ROUND_PATTERNS];
        this.maxRounds = opts.maxRounds ?? MAX_ROUNDS_DEFAULT;
        this.now = opts.now ?? Date.now;
        this.newRound();
    }

    private newRound(): void {
        this.rounds.push({
            index: this.roundIndex++,
            startedAt: this.now(),
            players: new Map(),
            weaponKills: {},
        });
        if (this.rounds.length > this.maxRounds) {
            this.rounds.splice(0, this.rounds.length - this.maxRounds);
        }
    }

    private get current(): RoundStats {
        return this.rounds[this.rounds.length - 1];
    }

    private player(name: string): PlayerRoundStats {
        let p = this.current.players.get(name);
        if (!p) {
            p = { kills: 0, deaths: 0, hits: 0, hitsTaken: 0, hitsByLocation: {}, weaponsUsed: {} };
            this.current.players.set(name, p);
        }
        return p;
    }

    private nameFor(clientNum: number): string {
        return this.namer(clientNum) ?? String(clientNum);
    }

    /** `onHit` — attacker dealt a hit to `victim` (unicast print). */
    noteHit(ev: { attacker: number; victim: string; location: string }): void {
        const p = this.player(this.nameFor(ev.attacker));
        p.hits++;
        const loc = ev.location || 'body';
        p.hitsByLocation[loc] = (p.hitsByLocation[loc] ?? 0) + 1;
    }

    /** `onHitTaken` — victim took a hit from `attacker` (unicast print). */
    noteHitTaken(ev: { victim: number; attacker: string }): void {
        this.player(this.nameFor(ev.victim)).hitsTaken++;
    }

    /**
     * `onObituary` — attacker kill + weapon attribution. Deaths themselves
     * are counted by `noteDeath` (the STAT_HEALTH → 0 edge is authoritative
     * and doesn't depend on obituary templates parsing the victim name).
     */
    noteObituary(ev: { victim: string; attacker: string | null; weapon: string | null; kind?: string }): void {
        // 'info' = not a death line (bot nav, renames); suicide/world
        // deaths have no attacker and award no kill. Deaths themselves
        // are counted by noteDeath (STAT_HEALTH → 0).
        if (ev.kind === 'info' || !ev.attacker) return;
        const killer = this.player(ev.attacker);
        killer.kills++;
        const w = ev.weapon ?? UNKNOWN_WEAPON;
        killer.weaponsUsed[w] = (killer.weaponsUsed[w] ?? 0) + 1;
        this.current.weaponKills[w] = (this.current.weaponKills[w] ?? 0) + 1;
    }

    /** `onDeath` — authoritative death edge for `clientNum`. */
    noteDeath(ev: { clientNum: number }): void {
        this.player(this.nameFor(ev.clientNum)).deaths++;
    }

    /**
     * Feed layout/centerprint text for round-boundary detection.
     * Returns true when the text opened a new round.
     */
    noteText(text: string): boolean {
        const line = text.trim();
        if (!this.roundPatterns.some((re) => re.test(line))) return false;
        this.newRound();
        return true;
    }

    reset(): void {
        this.rounds = [];
        this.roundIndex = 0;
        this.newRound();
    }

    snapshot(): StatsSnapshot {
        const totals: StatsSnapshot['totals'] = { players: {}, weaponKills: {} };
        const rounds = this.rounds.map((r) => {
            const players: Record<string, PlayerRoundStats> = {};
            for (const [name, p] of r.players) {
                players[name] = { ...p, hitsByLocation: { ...p.hitsByLocation }, weaponsUsed: { ...p.weaponsUsed } };
                const t = (totals.players[name] ??= {
                    kills: 0, deaths: 0, hits: 0, hitsTaken: 0, hitsByLocation: {}, weaponsUsed: {},
                });
                t.kills += p.kills;
                t.deaths += p.deaths;
                t.hits += p.hits;
                t.hitsTaken += p.hitsTaken;
                for (const [loc, n] of Object.entries(p.hitsByLocation)) {
                    t.hitsByLocation[loc] = (t.hitsByLocation[loc] ?? 0) + n;
                }
                for (const [w, n] of Object.entries(p.weaponsUsed)) {
                    t.weaponsUsed[w] = (t.weaponsUsed[w] ?? 0) + n;
                }
            }
            for (const [w, n] of Object.entries(r.weaponKills)) {
                totals.weaponKills[w] = (totals.weaponKills[w] ?? 0) + n;
            }
            return { index: r.index, startedAt: r.startedAt, players, weaponKills: { ...r.weaponKills } };
        });
        return { rounds, totals };
    }
}
