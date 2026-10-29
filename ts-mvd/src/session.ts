/**
 * A single MVD pipeline: GTV client + frame parser + derived state
 * (configstrings, player roster, scoreboard, chat/kill feeds, combat FX,
 * stats, recorder, replay).
 *
 * Extracted from app.ts so the transport layer stays socket-agnostic —
 * `broadcast` and `statusQuery` are injected, so a Session is usable
 * without an HTTP/SSE server. app.ts owns the shared resources (SSE client
 * set, UDP socket, pak index, HTTP routes) and a `sessions` map; today only
 * the 'default' session is exposed.
 *
 * Exclusivity between live and replay is a *policy* enforced by the routes
 * in app.ts, not by this class.
 */

import * as path from 'node:path';
import { MvdClient, MvdClientOptions } from './client';
import { MvdDemoReader } from './demo';
import { Mvd2Writer } from './mvd2-writer';
import { ClientState, Stat } from './protocol';
import {
    MvdFrameParser,
    PlayerState,
    ChatEvent,
    ObituaryEvent,
    LayoutEvent,
    MuzzleFlashEvent,
    TempEntityEvent,
    TeamScores,
    DeathEvent,
    SoundEvent,
    HitEvent,
    HitTakenEvent,
    CenterPrintEvent,
} from './frame';
import { StatsTracker } from './stats';
import { CombatFxResolver } from './combat-fx';
import {
    csLayout,
    extractAmmo,
    isAlive,
    isScoped,
    resolveSelectedItem,
    resolveWeaponLabel,
} from './player-loadout';

// ── Types ─────────────────────────────────────────────────────────

interface ChatEntry extends ChatEvent { t: number }
interface KillEntry extends ObituaryEvent { t: number }

export interface StatusPlayer {
    name: string;
    frags: number;
    ping: number;
}

export interface StatusData {
    serverinfo: Record<string, string>;
    players: StatusPlayer[];
}

export interface ScoreboardState {
    teamScores: TeamScores;
    layoutsFlags: number;
    layoutText: string;
    players: Record<number, { number: number; frags: number }>;
}

/** SSE / snapshot player payload (shared by frame + /events snapshot). */
export interface SsePlayerPayload {
    number: number;
    origin: [number, number, number];
    viewangles: [number, number, number];
    fov: number;
    gunindex: number;
    frags: number;
    health: number | undefined;
    alive: boolean;
    weapon: string | undefined;
    item: string | undefined;
    ammo: number | undefined;
    clips: number | undefined;
    grenades: number | undefined;
    scoped: boolean;
    pmType: number;
    weaponTypeNum: number | undefined;
}

export interface SessionOptions {
    host: string;
    port: number;
    /** Outbound sink for SSE-style events: `broadcast(event, payload)`. */
    broadcast: (event: string, data: unknown) => void;
    /** UDP OOB `status` query sender — injected because the socket is shared. */
    statusQuery: (host: string, port: number) => void;
    clientOpts?: Omit<MvdClientOptions, 'host' | 'port'>;
}

const CHAT_LOG_MAX = 200;
const KILL_FEED_MAX = 50;
const STATS_BROADCAST_MS = 2000;
const STATUS_QUERY_FRAMES = 30;

// Per-update configstring logging is extremely noisy on busy servers
// (hundreds of lines per player join); enable with TS_MVD_DEBUG=1.
const DEBUG = !!process.env.TS_MVD_DEBUG;

export class Session {
    readonly id: string;

    /** Live GTV target; mutated by POST /connect. */
    host: string;
    port: number;

    readonly client: MvdClient;
    readonly parser = new MvdFrameParser();
    readonly recorder = new Mvd2Writer();
    readonly combatFx = new CombatFxResolver();
    readonly stats: StatsTracker;

    readonly configstrings = new Map<number, string>();
    readonly players = new Map<number, PlayerState>();

    /** Configstring layout of the current stream (doc/configstring-layout.md). */
    csExtended = false;

    readonly chatLog: ChatEntry[] = [];
    readonly killFeed: KillEntry[] = [];
    readonly scoreboard: ScoreboardState = {
        teamScores: { team1: 0, team2: 0, team3: 0 },
        layoutsFlags: 0,
        layoutText: '',
        players: {},
    };

    latestStatus: StatusData | null = null;

    /** Active demo replay, if any. When non-null, live GTV must be idle. */
    currentReplay: MvdDemoReader | null = null;
    currentReplayFile: string | null = null;

    private readonly broadcast: (event: string, data: unknown) => void;
    private readonly statusQuery: (host: string, port: number) => void;
    private statsTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(id: string, opts: SessionOptions) {
        this.id = id;
        this.host = opts.host;
        this.port = opts.port;
        this.broadcast = opts.broadcast;
        this.statusQuery = opts.statusQuery;
        this.client = new MvdClient({
            host: this.host,
            port: this.port,
            ...(opts.clientOpts ?? {}),
        });
        this.stats = new StatsTracker({ namer: (n) => this.playerNameFor(n) });
        this.combatFx.notePlayers(this.players);
        this.attachPipeline();
    }

    /** clientNum → player name via the playerskin configstrings ("name\skin"). */
    playerNameFor(num: number): string | undefined {
        const cs = this.configstrings.get(csLayout(this.csExtended).playerskins + num);
        if (!cs) return undefined;
        const sep = cs.indexOf('\\');
        const name = sep === -1 ? '' : cs.substring(0, sep);
        return name || undefined;
    }

    private serializePlayer(p: PlayerState): SsePlayerPayload {
        const health = p.stats.length > Stat.Health ? p.stats[Stat.Health] : undefined;
        const healthVal = health ?? 0;
        const alive = isAlive(p.pmType, healthVal);
        const ammoStatus = extractAmmo(p.stats, alive);
        const sniperIcon = p.stats.length > Stat.SniperIcon ? p.stats[Stat.SniperIcon] : 0;
        const weapon = resolveWeaponLabel(
            { weaponTypeNum: p.weaponTypeNum, gunindex: p.gunindex, stats: p.stats, alive },
            this.configstrings,
            this.csExtended,
        );
        const item = resolveSelectedItem(p.stats, alive, this.configstrings, this.csExtended);
        const pos = MvdFrameParser.originToWorld(p.origin);
        return {
            number: p.number,
            origin: pos,
            viewangles: [...p.viewangles] as [number, number, number],
            fov: p.fov,
            gunindex: p.gunindex,
            frags: p.frags,
            health,
            alive,
            weapon,
            item,
            ammo: ammoStatus?.ammo,
            clips: ammoStatus?.clips,
            grenades: ammoStatus?.grenades,
            scoped: isScoped(p.fov, sniperIcon | 0),
            pmType: p.pmType,
            weaponTypeNum: p.weaponTypeNum,
        };
    }

    // ── Pipeline wiring (replaces the app.ts onFrame wrapper chain) ──

    private attachPipeline(): void {
        const { parser, client } = this;

        parser.onServerData = (ev) => {
            this.configstrings.clear();
            this.players.clear();
            this.csExtended = ev.extended;
            for (const [index, value] of ev.configstrings) {
                this.configstrings.set(index, value);
            }
            console.log(`[serverdata] protocol=${ev.protocol} version=${ev.version} flags=0x${ev.flags.toString(16)}`);
            console.log(`[serverdata] gamedir="${ev.gamedir}" clientNum=${ev.clientNum}`);
            if (DEBUG) {
                for (const [index, value] of ev.configstrings) {
                    if (index <= 5 || (index >= 32 && index <= 34)) {
                        console.log(`  [cs ${index}] "${value}"`);
                    }
                }
            }

            // Map changed: flush transient state so stale chat/kills don't linger.
            this.chatLog.length = 0;
            this.killFeed.length = 0;
            this.scoreboard.players = {};
            this.scoreboard.teamScores = { team1: 0, team2: 0, team3: 0 };
            this.scoreboard.layoutsFlags = 0;
            this.scoreboard.layoutText = '';

            const cs: Record<number, string> = {};
            for (const [k, v] of ev.configstrings) cs[k] = v;
            this.broadcast('serverdata', {
                session: this.id,
                protocol: ev.protocol,
                version: ev.version,
                flags: ev.flags,
                extended: ev.extended,
                gamedir: ev.gamedir,
                clientNum: ev.clientNum,
                configstrings: cs,
            });
        };

        parser.onConfigString = (ev) => {
            this.configstrings.set(ev.index, ev.value);
            if (DEBUG) console.log(`[configstring ${ev.index}] "${ev.value}"`);
            // Drop scoreboard entries when a player slot's playerskin
            // configstring is cleared (the server's disconnect signal). The
            // playerskins base must come from the negotiated layout.
            if (ev.value === '') {
                const bases = csLayout(this.csExtended);
                const maxclients = parseInt(this.configstrings.get(bases.maxclients) ?? '0', 10);
                const cap = maxclients > 0 && maxclients <= 256 ? maxclients : 256;
                if (ev.index >= bases.playerskins && ev.index < bases.playerskins + cap) {
                    delete this.scoreboard.players[ev.index - bases.playerskins];
                }
            }
            this.broadcast('configstring', { session: this.id, ...ev });
        };

        parser.onFrame = (ev) => {
            // The MVD observer dummy (slot at serverData.clientNum) is
            // filtered out everywhere — never rendered, tracked, or
            // scoreboarded. Always clear/rebuild so combat-fx and snapshot
            // state match the stream roster.
            this.players.clear();
            for (const p of ev.players) {
                if (p.isMvdDummy) continue;
                this.players.set(p.number, p);
            }

            // Merge rather than replace: a player briefly absent from
            // ev.players keeps their accumulated frags.
            this.scoreboard.teamScores = ev.teamScores;
            this.scoreboard.layoutsFlags = ev.layoutsFlags;
            for (const p of ev.players) {
                if (p.isMvdDummy) continue;
                this.scoreboard.players[p.number] = { number: p.number, frags: p.frags };
            }

            this.broadcast('frame', {
                session: this.id,
                frameNumber: ev.frameNumber,
                players: ev.players
                    .filter((p) => !p.isMvdDummy)
                    .map((p) => this.serializePlayer(p)),
                teamScores: ev.teamScores,
                layoutsFlags: ev.layoutsFlags,
            });

            // Periodic OOB status poll — skipped while replaying a demo.
            if (!this.currentReplay && ev.frameNumber > 0 && ev.frameNumber % STATUS_QUERY_FRAMES === 0) {
                this.statusQuery(this.host, this.port);
            }
        };

        parser.onChat = (ev: ChatEvent) => {
            const entry: ChatEntry = { ...ev, t: Date.now() };
            this.chatLog.push(entry);
            if (this.chatLog.length > CHAT_LOG_MAX) {
                this.chatLog.splice(0, this.chatLog.length - CHAT_LOG_MAX);
            }
            console.log(`[chat] ${ev.name ? ev.name + ': ' : ''}${ev.text}`);
            this.broadcast('chat', { session: this.id, ...entry });
        };

        parser.onObituary = (ev: ObituaryEvent) => {
            const entry: KillEntry = { ...ev, t: Date.now() };
            this.killFeed.push(entry);
            if (this.killFeed.length > KILL_FEED_MAX) {
                this.killFeed.splice(0, this.killFeed.length - KILL_FEED_MAX);
            }
            // Strip control bytes (notably BEL 0x07 — the in-game kill ding).
            const safe = ev.raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
            console.log(`[kill] ${safe}`);
            this.broadcast('kill', { session: this.id, ...entry });
            this.stats.noteObituary(ev);
            this.broadcastStats();
        };

        parser.onHit = (ev: HitEvent) => {
            this.broadcast('hit', { session: this.id, kind: 'dealt', ...ev });
            this.stats.noteHit(ev);
            this.scheduleStatsBroadcast();
        };

        parser.onHitTaken = (ev: HitTakenEvent) => {
            this.broadcast('hit', { session: this.id, kind: 'taken', ...ev });
            this.stats.noteHitTaken(ev);
            this.scheduleStatsBroadcast();
        };

        parser.onDeath = (ev: DeathEvent) => {
            this.broadcast('death', { session: this.id, clientNum: ev.clientNum, origin: ev.origin, t: Date.now() });
            this.stats.noteDeath(ev);
            this.broadcastStats();
        };

        parser.onLayout = (ev: LayoutEvent) => {
            this.scoreboard.layoutText = ev.text;
            this.broadcast('layout', { session: this.id, ...ev });
            if (this.stats.noteText(ev.text)) this.broadcastStats();
        };

        // Centerprints carry AQ2's round-boundary signals ("FIGHT!"/"ACTION!").
        parser.onCenterPrint = (ev: CenterPrintEvent) => {
            if (this.stats.noteText(ev.text)) this.broadcastStats();
        };

        // End-of-match broadcasts ("Timelimit hit.", "Fraglimit hit.",
        // "Match ended.") arrive as mvd_print ops (no clientNum). Unicast
        // prints (hit markers etc.) are per-recipient and stay out of
        // round detection.
        parser.onPrint = (ev) => {
            if (ev.clientNum === undefined && this.stats.noteText(ev.text)) {
                this.broadcastStats();
            }
        };

        // TE_BLOOD / TE_SPARKS / TE_BULLET_SPARKS near a player → damage FX.
        parser.onTempEntity = (ev: TempEntityEvent) => {
            const dmg = this.combatFx.handleTE(ev);
            if (dmg) this.broadcast('damage', { session: this.id, ...dmg });
        };

        parser.onMuzzleFlash = (ev: MuzzleFlashEvent) => {
            if (ev.entity <= 0) return;
            this.broadcast('flash', {
                session: this.id,
                shooter: ev.entity - 1,
                weapon: ev.weapon,
                silenced: ev.silenced,
                t: Date.now(),
            });
        };

        parser.onSound = (ev: SoundEvent) => {
            const name = this.configstrings.get(csLayout(this.csExtended).sounds + ev.index);
            this.broadcast('sound', {
                session: this.id,
                index: ev.index,
                name,
                channel: ev.channel,
                entity: ev.entity,
                position: ev.position,
                volume: ev.volume,
                attenuation: ev.attenuation,
                t: Date.now(),
            });
        };

        // ── Client lifecycle ──────────────────────────────────────

        client.on('stateChange', ({ from, to }) => {
            console.log(`[state] ${from} -> ${to}`);
        });
        client.on('connect', () => {
            console.log('[connect] Magic exchanged, sending hello...');
        });
        client.on('hello', (flags) => {
            console.log(`[hello] Negotiated flags: 0x${flags.toString(16)}`);
        });
        client.on('streamStart', () => {
            console.log('[stream] Started');
        });
        client.on('streamData', (data) => {
            this.recorder.writeMessage(data);
            try {
                parser.parse(data);
            } catch (err) {
                console.error('[parse] Error parsing stream data, dropping frame:', err);
                parser.reset();
            }
        });
        client.on('streamResume', (data) => {
            console.log(`[stream] Resumed`);
            this.recorder.writeMessage(data);
            try {
                parser.parse(data);
            } catch (err) {
                console.error('[parse] Error parsing resumed stream data, dropping frame:', err);
                parser.reset();
            }
        });
        client.on('streamSuspend', () => {
            console.log('[stream] Suspended (no active players)');
        });
        client.on('streamStop', () => {
            console.log('[stream] Stopped');
        });
        client.on('pong', () => {
            console.log('[pong]');
        });
        client.on('error', ({ code, message }) => {
            console.error(`[error] ${code}: ${message}`);
        });
        client.on('disconnect', ({ reason }) => {
            console.log(`[disconnect] ${reason}`);
        });
        client.on('close', () => {
            console.log('[close] Connection closed');
            const fin = this.recorder.close();
            if (fin) {
                console.log(`[record] Stopped on disconnect (${fin.messages} messages → ${fin.file})`);
                this.broadcast('recordStop', {
                    session: this.id,
                    file: path.basename(fin.file),
                    messages: fin.messages,
                    bytes: fin.bytes,
                    reason: 'disconnect',
                });
            }
            this.broadcast('liveStop', { session: this.id });
        });
    }

    // ── Stats broadcast coalescing ────────────────────────────────

    broadcastStats(): void {
        this.broadcast('stats', { session: this.id, ...this.stats.snapshot() });
    }

    private scheduleStatsBroadcast(): void {
        if (this.statsTimer) return;
        this.statsTimer = setTimeout(() => {
            this.statsTimer = null;
            this.broadcastStats();
        }, STATS_BROADCAST_MS);
        this.statsTimer.unref();
    }

    // ── Replay control ────────────────────────────────────────────

    replayStatePayload() {
        if (!this.currentReplay) return null;
        return {
            file: path.basename(this.currentReplayFile ?? ''),
            paused: this.currentReplay.paused,
            speed: this.currentReplay.speed,
            position: this.currentReplay.position,
            messageCount: this.currentReplay.messageCount,
        };
    }

    broadcastReplayState(): void {
        const s = this.replayStatePayload();
        if (s) this.broadcast('replayState', { session: this.id, ...s });
    }

    startReplay(filePath: string): void {
        // A pending auto-reconnect back-off must not outlive the switch to
        // replay — disconnect() clears the timer (and is a no-op when the
        // socket is already gone). Live connections are rejected upstream
        // by the route's state check.
        this.client.disconnect();
        this.resetPipelineState();
        const reader = new MvdDemoReader({ realtime: true, tickMs: 100 });
        this.currentReplay = reader;
        this.currentReplayFile = filePath;

        reader.on('message', (buf) => {
            try {
                this.parser.parse(buf);
            } catch (err) {
                console.error('[replay] Parse error, dropping frame:', err);
                this.parser.reset();
            }
        });
        reader.on('end', () => {
            console.log('[replay] End');
            this.currentReplay = null;
            this.currentReplayFile = null;
            this.broadcast('replayEnd', { session: this.id });
        });
        reader.on('error', (err) => {
            console.error('[replay] Error:', err.message);
            this.currentReplay = null;
            this.currentReplayFile = null;
            this.broadcast('replayError', { session: this.id, message: err.message });
        });
        // A seek jumps to an earlier keyframe; all derived state rebuilds
        // from there.
        reader.on('seek', () => {
            this.resetPipelineState();
            this.broadcastReplayState();
        });
        reader.on('pause', () => this.broadcastReplayState());
        reader.on('resume', () => this.broadcastReplayState());

        this.broadcast('replayStart', { session: this.id, file: filePath });
        console.log(`[replay] Starting ${filePath}`);
        reader.play(filePath);
    }

    stopReplay(): boolean {
        if (!this.currentReplay) return false;
        this.currentReplay.stop();
        this.currentReplay = null;
        this.currentReplayFile = null;
        this.broadcast('replayEnd', { session: this.id });
        console.log('[replay] Stopped');
        return true;
    }

    // ── State lifecycle ───────────────────────────────────────────

    resetPipelineState(): void {
        this.parser.reset();
        this.configstrings.clear();
        this.players.clear();
        this.csExtended = false;
        this.combatFx.reset();
        this.stats.reset();
        if (this.statsTimer) {
            clearTimeout(this.statsTimer);
            this.statsTimer = null;
        }
        this.combatFx.notePlayers(this.players);
        this.chatLog.length = 0;
        this.killFeed.length = 0;
        this.scoreboard.teamScores = { team1: 0, team2: 0, team3: 0 };
        this.scoreboard.layoutsFlags = 0;
        this.scoreboard.layoutText = '';
        this.scoreboard.players = {};
        this.latestStatus = null;
    }

    /** Snapshot payload for the /events SSE stream. */
    snapshot(): Record<string, unknown> {
        const cs: Record<number, string> = {};
        for (const [k, v] of this.configstrings) cs[k] = v;
        return {
            session: this.id,
            configstrings: cs,
            extended: this.csExtended,
            players: Array.from(this.players.values()).map((p) => this.serializePlayer(p)),
            status: this.latestStatus,
            chatLog: this.chatLog,
            killFeed: this.killFeed,
            scoreboard: this.scoreboard,
            replay: this.replayStatePayload(),
            stats: this.stats.snapshot(),
        };
    }

    /** Mode for /state: replay beats live, live beats idle. */
    get mode(): 'replay' | 'live' | 'idle' {
        if (this.currentReplay) return 'replay';
        // A scheduled auto-reconnect still counts as live — the client
        // will be back shortly, so the UI should not offer the session
        // modal nor let /replay slip in without cancelling it.
        if (this.client.state === ClientState.Disconnected && !this.client.reconnectPending) {
            return 'idle';
        }
        return 'live';
    }

    /**
     * Release every owned resource: live socket + ping/reconnect timers,
     * stats broadcast timer, replay reader, recorder fd. The session is
     * unusable afterwards (client listeners are removed).
     */
    dispose(): void {
        this.stopReplay();
        this.client.disconnect();
        this.client.removeAllListeners();
        if (this.statsTimer) {
            clearTimeout(this.statsTimer);
            this.statsTimer = null;
        }
        this.recorder.close();
    }
}
