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
    /** Damage dealt this round (from `TE_DAMAGE_DEALT` unicast TEs — the
     *  same number AQ2 shows the attacker as a hit marker; excludes
     *  friendly fire / warmup / telefrag). */
    damageDealt: number;
    /** Dealt hits by body location: head/chest/stomach/legs/body/''. */
    hitsByLocation: Record<string, number>;
    /** Kills dealt by weapon token (obituary template; 'unknown' when null). */
    weaponsUsed: Record<string, number>;
}

/** Team-score tally (STAT_TEAM{1,2,3}_SCORE); structurally decoupled from
 *  frame.ts's TeamScores so the tracker stays parser-free. */
export interface ScoreTally {
    team1: number;
    team2: number;
    team3: number;
}

export interface RoundStats {
    index: number;
    startedAt: number;
    players: Map<string, PlayerRoundStats>;
    /** Kills by weapon token, aggregated over the round's players. */
    weaponKills: Record<string, number>;
    /** Team scores at the round's close (end-marker or next round start). */
    teamScores?: ScoreTally;
    /** Clock when an end marker ("The round is over:") closed the round. */
    endedAt?: number;
}

export interface StatsSnapshot {
    rounds: Array<{
        index: number;
        startedAt: number;
        endedAt?: number;
        players: Record<string, PlayerRoundStats>;
        weaponKills: Record<string, number>;
        teamScores?: ScoreTally;
        /** Strict argmax of teamScores; 'tie' on equal top scores,
         *  absent when no team scores were ever seen. */
        winner?: string;
    }>;
    totals: {
        players: Record<string, PlayerRoundStats>;
        weaponKills: Record<string, number>;
        /** Count of `TE_DAMAGE_DEALT` events seen — nonzero proves the
         *  stream carries AQ2's hit-marker TE even when per-player
         *  `damageDealt` attributions look wrong. */
        damageEvents: number;
    };
}

export interface StatsTrackerOptions {
    /** Resolve a clientNum to a player name (playerskin configstring). */
    namer?: (clientNum: number) => string | undefined;
    /** Texts matching any pattern open a new round. */
    roundPatterns?: RegExp[];
    /** Texts matching any pattern CLOSE the current round (stamp final
     *  team scores) without opening a new one. */
    endPatterns?: RegExp[];
    /** Retained completed rounds + the live one (default 64). */
    maxRounds?: number;
    now?: () => number;
}

/**
 * Heuristic round-boundary patterns. AQ2 has no protocol marker for round
 * start/end; TNG signals via `CenterPrintAll("LIGHTS…/CAMERA…/ACTION!")`
 * (src/action/a_team.c) and broadcasts end-of-match prints
 * ("Timelimit hit.", "Fraglimit hit.", "Match ended.") — the same strings
 * `MVD_ParsePrint` special-cases. These patterns are deliberately narrow —
 * false positives only split stats, never corrupt them. Configurable via
 * `StatsTrackerOptions.roundPatterns`.
 */
export const DEFAULT_ROUND_PATTERNS: readonly RegExp[] = [
    /^fight!*$/i,
    /^action!?$/i,
    /^round\s+\d+/i,
    /round begins/i,
    /match start/i,
    /^(timelimit|fraglimit) hit/i,
    /match ended/i,
];

/**
 * Round-END markers: a matching text stamps the current round's final
 * team scores + endedAt instead of opening a new round. AQ2's WonGame
 * broadcasts "The round is over:" at PRINT_HIGH before "X won!" /
 * "It was a tie" (src/action/a_team.c:2772); the team-score stats
 * (STAT_TEAM{1,2,3}_SCORE) have already been incremented by then, so the
 * tally seen by noteScores is the round's final result.
 */
export const DEFAULT_END_PATTERNS: readonly RegExp[] = [
    /^the round is over/i,
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
    private readonly endPatterns: RegExp[];
    private readonly maxRounds: number;
    private readonly now: () => number;

    private rounds: RoundStats[] = [];
    private roundIndex = 0;
    private latestScores: ScoreTally = { team1: 0, team2: 0, team3: 0 };
    private sawScores = false;
    private damageEventCount = 0;

    constructor(opts: StatsTrackerOptions = {}) {
        this.namer = opts.namer ?? (() => undefined);
        this.roundPatterns = opts.roundPatterns ?? [...DEFAULT_ROUND_PATTERNS];
        this.endPatterns = opts.endPatterns ?? [...DEFAULT_END_PATTERNS];
        this.maxRounds = opts.maxRounds ?? MAX_ROUNDS_DEFAULT;
        this.now = opts.now ?? Date.now;
        this.newRound();
    }

    private newRound(): void {
        // Closing a round (implicitly, on the next start marker): stamp its
        // final team scores if no end marker did so already. All-zero tallies
        // are skipped — they appear on DM streams and pre-score segments.
        const prev = this.rounds[this.rounds.length - 1];
        if (prev && !prev.teamScores && this.sawScores
            && (this.latestScores.team1 || this.latestScores.team2 || this.latestScores.team3)) {
            prev.teamScores = { ...this.latestScores };
        }
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
            p = { kills: 0, deaths: 0, hits: 0, hitsTaken: 0, damageDealt: 0, hitsByLocation: {}, weaponsUsed: {} };
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
     * `onTempEntity` `TE_DAMAGE_DEALT` — AQ2 unicasts the attacker a
     * `[short damage]` per frame; `attacker` is the unicast recipient
     * (`TempEntityEvent.clientNum`), `damage` is the TE's count field.
     */
    noteDamageDealt(ev: { attacker: number; damage: number }): void {
        this.damageEventCount++;
        this.player(this.nameFor(ev.attacker)).damageDealt += ev.damage;
    }

    /** Latest team scores from FrameEvent.teamScores — fed each frame. */
    noteScores(scores: ScoreTally): void {
        this.latestScores = { ...scores };
        this.sawScores = true;
        // The STAT_TEAM*_SCORE delta lands a frame or two AFTER the end
        // print ("The round is over:" precedes WonGame's score++ delta).
        // An ended-but-unstamped round keeps absorbing updates until the
        // next round opens.
        const cur = this.current;
        if (cur && cur.endedAt !== undefined && !cur.teamScores
            && (scores.team1 || scores.team2 || scores.team3)) {
            cur.teamScores = { ...scores };
        }
    }

    /**
     * Feed layout/centerprint/broadcast text for round-boundary detection.
     * Returns true when the text opened a new round OR closed the current
     * one (end markers stamp final team scores, no new round opens).
     */
    noteText(text: string): boolean {
        const line = text.trim();
        if (this.roundPatterns.some((re) => re.test(line))) {
            this.newRound();
            return true;
        }
        if (this.endPatterns.some((re) => re.test(line))) {
            const cur = this.current;
            cur.endedAt = this.now();
            if (this.sawScores && !cur.teamScores
                && (this.latestScores.team1 || this.latestScores.team2 || this.latestScores.team3)) {
                cur.teamScores = { ...this.latestScores };
            }
            return true;
        }
        return false;
    }

    reset(): void {
        this.rounds = [];
        this.roundIndex = 0;
        this.latestScores = { team1: 0, team2: 0, team3: 0 };
        this.sawScores = false;
        this.damageEventCount = 0;
        this.newRound();
    }

    snapshot(): StatsSnapshot {
        const totals: StatsSnapshot['totals'] = {
            players: {},
            weaponKills: {},
            damageEvents: this.damageEventCount,
        };
        const rounds = this.rounds.map((r) => {
            const players: Record<string, PlayerRoundStats> = {};
            for (const [name, p] of r.players) {
                players[name] = { ...p, hitsByLocation: { ...p.hitsByLocation }, weaponsUsed: { ...p.weaponsUsed } };
                const t = (totals.players[name] ??= {
                    kills: 0, deaths: 0, hits: 0, hitsTaken: 0, damageDealt: 0, hitsByLocation: {}, weaponsUsed: {},
                });
                t.kills += p.kills;
                t.deaths += p.deaths;
                t.hits += p.hits;
                t.hitsTaken += p.hitsTaken;
                t.damageDealt += p.damageDealt;
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
            // The live round shows the latest tally; closed rounds keep
            // the scores stamped at their close.
            const scores = r.teamScores
                ?? (this.rounds[this.rounds.length - 1] === r && this.sawScores
                        && (this.latestScores.team1 || this.latestScores.team2 || this.latestScores.team3)
                    ? this.latestScores
                    : undefined);
            let winner: string | undefined;
            if (scores) {
                const top = Math.max(scores.team1, scores.team2, scores.team3);
                if (top > 0) {
                    const tops = [
                        ['team1', scores.team1], ['team2', scores.team2], ['team3', scores.team3],
                    ].filter(([, v]) => v === top) as Array<[string, number]>;
                    winner = tops.length === 1 ? tops[0][0] : 'tie';
                }
            }
            return {
                index: r.index,
                startedAt: r.startedAt,
                endedAt: r.endedAt,
                players,
                weaponKills: { ...r.weaponKills },
                teamScores: scores ? { ...scores } : undefined,
                winner,
            };
        });
        return { rounds, totals };
    }
}
