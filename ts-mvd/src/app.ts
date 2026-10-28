import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MvdClient } from './index';
import { MvdDemoReader } from './demo';
import { Mvd2Writer } from './mvd2-writer';
import { ClientState, Stat } from './protocol';
import {
    MvdFrameParser,
    PlayerState,
    ChatEvent,
    ObituaryEvent,
    HitEvent,
    HitTakenEvent,
    LayoutEvent,
    CenterPrintEvent,
    MuzzleFlashEvent,
    TempEntityEvent,
    TeamScores,
    DeathEvent,
    SoundEvent,
} from './frame';
import { StatsTracker } from './stats';
import { BspFile } from './bsp';
import { generateMapSvg } from './map-render';
import { CombatFxResolver } from './combat-fx';
import { PakIndex } from './pak';
import {
    csLayout,
    extractAmmo,
    isAlive,
    isScoped,
    resolveSelectedItem,
    resolveWeaponLabel,
} from './player-loadout';

const defaultHost = process.argv[2] || '127.0.0.1';
const defaultPort = parseInt(process.argv[3] || '27910', 10);

// Live GTV target; mutated by POST /connect so the UI can pick host/port.
let host = defaultHost;
let port = defaultPort;

const client = new MvdClient({
    host,
    port,
    username: 'ts-mvd',
    password: '',
    autoReconnect: true,
    reconnectDelay: 5000,
});

// Active demo replay, if any. When non-null, live GTV is expected to be idle
// and UDP OOB polling is skipped.
let currentReplay: MvdDemoReader | null = null;
let currentReplayFile: string | null = null;

// Live .mvd2 recorder; every streamData/streamResume payload is framed and
// appended while `recorder.recording` (see doc/live-recording.md).
const recorder = new Mvd2Writer();

const parser = new MvdFrameParser();

const configstrings = new Map<number, string>();
const players = new Map<number, PlayerState>();

const combatFx = new CombatFxResolver();
combatFx.notePlayers(players);

// ── Chat / kill-feed / scoreboard state ─────────────────────────

const CHAT_LOG_MAX = 200;
const KILL_FEED_MAX = 50;

// Configstring layout of the current stream, taken from
// `ServerDataEvent.extended` (see doc/configstring-layout.md). Drives
// weapon/item lookups and playerskin-index math — probing both layouts is
// wrong because the EXT bases alias into the vanilla CS_MODELS range.
let csExtended = false;

interface ChatEntry extends ChatEvent { t: number }
interface KillEntry extends ObituaryEvent { t: number }

const chatLog: ChatEntry[] = [];
const killFeed: KillEntry[] = [];

/** clientNum → player name via the playerskin configstrings ("name\skin"). */
function playerNameFor(num: number): string | undefined {
    const cs = configstrings.get(csLayout(csExtended).playerskins + num);
    if (!cs) return undefined;
    const sep = cs.indexOf('\\');
    const name = sep === -1 ? '' : cs.substring(0, sep);
    return name || undefined;
}

const stats = new StatsTracker({ namer: playerNameFor });
// Hits arrive per-frame; coalesce stats SSE to one broadcast per window so
// a busy firefight doesn't emit a snapshot per print.
let statsTimer: ReturnType<typeof setTimeout> | null = null;
const STATS_BROADCAST_MS = 2000;

function broadcastStats(): void {
    sseBroadcast('stats', stats.snapshot());
}

function scheduleStatsBroadcast(): void {
    if (statsTimer) return;
    statsTimer = setTimeout(() => {
        statsTimer = null;
        broadcastStats();
    }, STATS_BROADCAST_MS);
    statsTimer.unref();
}
const scoreboard = {
    teamScores: { team1: 0, team2: 0, team3: 0 } as TeamScores,
    layoutsFlags: 0,
    layoutText: '' as string,
    players: {} as Record<number, { number: number; frags: number }>,
};

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

function serializePlayerForSse(p: PlayerState): SsePlayerPayload {
    const health = p.stats.length > Stat.Health ? p.stats[Stat.Health] : undefined;
    const healthVal = health ?? 0;
    const alive = isAlive(p.pmType, healthVal);
    const ammoStatus = extractAmmo(p.stats, alive);
    const sniperIcon = p.stats.length > Stat.SniperIcon ? p.stats[Stat.SniperIcon] : 0;
    const weapon = resolveWeaponLabel(
        {
            weaponTypeNum: p.weaponTypeNum,
            gunindex: p.gunindex,
            stats: p.stats,
            alive,
        },
        configstrings,
        csExtended,
    );
    const item = resolveSelectedItem(p.stats, alive, configstrings, csExtended);
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

parser.onServerData = (ev) => {
    configstrings.clear();
    players.clear();
    csExtended = ev.extended;
    for (const [index, value] of ev.configstrings) {
        configstrings.set(index, value);
    }
    console.log(`[serverdata] protocol=${ev.protocol} version=${ev.version} flags=0x${ev.flags.toString(16)}`);
    console.log(`[serverdata] gamedir="${ev.gamedir}" clientNum=${ev.clientNum}`);

    // Show a few interesting configstrings
    for (const [index, value] of ev.configstrings) {
        if (index <= 5 || (index >= 32 && index <= 34)) {
            console.log(`  [cs ${index}] "${value}"`);
        }
    }
};

// Per-update configstring logging is extremely noisy on busy servers
// (hundreds of lines per player join); enable with TS_MVD_DEBUG=1.
const DEBUG = !!process.env.TS_MVD_DEBUG;

parser.onConfigString = (ev) => {
    configstrings.set(ev.index, ev.value);
    if (DEBUG) console.log(`[configstring ${ev.index}] "${ev.value}"`);
};

parser.onFrame = (ev) => {
    // Update players map. The MVD observer dummy (the slot at
    // serverData.clientNum) is filtered out here so it is never rendered,
    // tracked by combat FX, or shown in the scoreboard. See
    // `src/server/mvd/game.c` in Q2Pro for the analogous `player == mvd->dummy`
    // filters. Always clear/rebuild — including empty frames — so combat-fx
    // and snapshot state match the stream roster (§2).
    players.clear();
    for (const p of ev.players) {
        if (p.isMvdDummy) continue;
        players.set(p.number, p);
    }
};

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
    recorder.writeMessage(data);
    try {
        parser.parse(data);
    } catch (err) {
        console.error('[parse] Error parsing stream data, dropping frame:', err);
        parser.reset();
    }
});

client.on('streamResume', (data) => {
    console.log(`[stream] Resumed`);
    recorder.writeMessage(data);
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
    const fin = recorder.close();
    if (fin) {
        console.log(`[record] Stopped on disconnect (${fin.messages} messages → ${fin.file})`);
        sseBroadcast('recordStop', { file: path.basename(fin.file), messages: fin.messages, bytes: fin.bytes, reason: 'disconnect' });
    }
    sseBroadcast('liveStop', {});
});

// ── SSE client management ───────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

// SSE hygiene: stalled subscribers are dropped once their buffered output
// exceeds 1 MiB (frame events stream at ~10 Hz and would otherwise pile up
// unboundedly), and a comment heartbeat keeps proxies and NATs from
// reaping idle connections while the stream is suspended.
const SSE_HEARTBEAT_MS = 25_000;
const SSE_MAX_BUFFERED_BYTES = 1 << 20;

function sseWrite(res: http.ServerResponse, payload: string): void {
    if (!res.write(payload) && res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        sseClients.delete(res);
        res.end();
    }
}

function sseBroadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        sseWrite(res, payload);
    }
}

/** One heartbeat round; exported so tests can drive it without timers. */
export function sseHeartbeatTick(): void {
    for (const res of sseClients) {
        sseWrite(res, ':hb\n\n');
    }
}

const sseHeartbeat = setInterval(sseHeartbeatTick, SSE_HEARTBEAT_MS);
// Unref so importing this module (tests, embedders) never keeps the
// process alive on its own.
sseHeartbeat.unref();

// Broadcast player state on every frame
const origOnFrame = parser.onFrame;
parser.onFrame = (ev) => {
    origOnFrame?.(ev);

    // Keep the scoreboard in sync with live stats. Merge rather than replace:
    // a player who is briefly absent from ev.players (e.g. PPS_REMOVE on the
    // tick they die / respawn) must keep their accumulated frags. Entries are
    // pruned on map change (resetPipelineState / onServerData) and on player
    // disconnect (empty CS_PLAYERSKINS configstring).
    scoreboard.teamScores = ev.teamScores;
    scoreboard.layoutsFlags = ev.layoutsFlags;
    for (const p of ev.players) {
        if (p.isMvdDummy) continue;
        scoreboard.players[p.number] = { number: p.number, frags: p.frags };
    }

    sseBroadcast('frame', {
        frameNumber: ev.frameNumber,
        players: ev.players
            .filter((p) => !p.isMvdDummy)
            .map((p) => serializePlayerForSse(p)),
        teamScores: ev.teamScores,
        layoutsFlags: ev.layoutsFlags,
    });
};

const origOnServerData = parser.onServerData;
parser.onServerData = (ev) => {
    origOnServerData?.(ev);
    // Map changed: flush transient state so stale chat/kills don't linger.
    chatLog.length = 0;
    killFeed.length = 0;
    scoreboard.players = {};
    scoreboard.teamScores = { team1: 0, team2: 0, team3: 0 };
    scoreboard.layoutsFlags = 0;
    scoreboard.layoutText = '';

    const cs: Record<number, string> = {};
    for (const [k, v] of ev.configstrings) cs[k] = v;
    sseBroadcast('serverdata', {
        protocol: ev.protocol,
        version: ev.version,
        flags: ev.flags,
        extended: ev.extended,
        gamedir: ev.gamedir,
        clientNum: ev.clientNum,
        configstrings: cs,
    });
};

const origOnConfigString = parser.onConfigString;
parser.onConfigString = (ev) => {
    origOnConfigString?.(ev);
    // Drop scoreboard entries when a player slot's playerskin configstring is
    // cleared (the server's signal that the client has disconnected). The
    // playerskins base must come from the negotiated layout — the other
    // layout's base aliases into a different configstring range.
    if (ev.value === '') {
        const bases = csLayout(csExtended);
        const maxclients = parseInt(configstrings.get(bases.maxclients) ?? '0', 10);
        const cap = maxclients > 0 && maxclients <= 256 ? maxclients : 256;
        if (ev.index >= bases.playerskins && ev.index < bases.playerskins + cap) {
            delete scoreboard.players[ev.index - bases.playerskins];
        }
    }
    sseBroadcast('configstring', ev);
};

// ── Chat / obituary / hit / layout wiring ───────────────────────

parser.onChat = (ev: ChatEvent) => {
    const entry: ChatEntry = { ...ev, t: Date.now() };
    chatLog.push(entry);
    if (chatLog.length > CHAT_LOG_MAX) chatLog.splice(0, chatLog.length - CHAT_LOG_MAX);
    console.log(`[chat] ${ev.name ? ev.name + ': ' : ''}${ev.text}`);
    sseBroadcast('chat', entry);
};

parser.onObituary = (ev: ObituaryEvent) => {
    const entry: KillEntry = { ...ev, t: Date.now() };
    killFeed.push(entry);
    if (killFeed.length > KILL_FEED_MAX) killFeed.splice(0, killFeed.length - KILL_FEED_MAX);
    // Strip control bytes (notably BEL 0x07, which Q2 embeds in obituaries
    // as the in-game kill "ding") so the terminal does not ring.
    const safe = ev.raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    console.log(`[kill] ${safe}`);
    sseBroadcast('kill', entry);
    stats.noteObituary(ev);
    broadcastStats();
};

parser.onHit = (ev: HitEvent) => {
    sseBroadcast('hit', { kind: 'dealt', ...ev });
    stats.noteHit(ev);
    scheduleStatsBroadcast();
};

parser.onHitTaken = (ev: HitTakenEvent) => {
    sseBroadcast('hit', { kind: 'taken', ...ev });
    stats.noteHitTaken(ev);
    scheduleStatsBroadcast();
};

parser.onDeath = (ev: DeathEvent) => {
    sseBroadcast('death', { clientNum: ev.clientNum, origin: ev.origin, t: Date.now() });
    stats.noteDeath(ev);
    broadcastStats();
};

parser.onLayout = (ev: LayoutEvent) => {
    scoreboard.layoutText = ev.text;
    sseBroadcast('layout', ev);
    if (stats.noteText(ev.text)) broadcastStats();
};

// Centerprints carry AQ2's round-boundary signals ("FIGHT!" etc.) — feed
// the stats tracker; no other consumer needs them yet.
parser.onCenterPrint = (ev: CenterPrintEvent) => {
    if (stats.noteText(ev.text)) broadcastStats();
};

// TE_BLOOD / TE_SPARKS / TE_BULLET_SPARKS near a player → damage FX on that
// player. Wall-impact sparks are rejected by the nearest-player distance cap
// inside `CombatFxResolver`. All other TE types (explosions, rail trails,
// etc.) are ignored by the combat-FX pipeline.
parser.onTempEntity = (ev: TempEntityEvent) => {
    const dmg = combatFx.handleTE(ev);
    if (dmg) sseBroadcast('damage', dmg);
};

// Every primary-fire muzzleflash surfaces as a per-shooter cone flash in
// the UI. Multicast, so unaffected by `sv_mvd_nomsgs`.
parser.onMuzzleFlash = (ev: MuzzleFlashEvent) => {
    if (ev.entity <= 0) return;
    sseBroadcast('flash', {
        shooter: ev.entity - 1,
        weapon: ev.weapon,
        silenced: ev.silenced,
        t: Date.now(),
    });
};

// Sound packets → positional map ping + resolved sample name. The name comes
// from the CS_SOUNDS range of the negotiated layout (see sound-events doc).
parser.onSound = (ev: SoundEvent) => {
    const name = configstrings.get(csLayout(csExtended).sounds + ev.index);
    sseBroadcast('sound', {
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

// ── OOB status polling via UDP ───────────────────────────────────

interface StatusPlayer {
    name: string;
    frags: number;
    ping: number;
}

interface StatusData {
    serverinfo: Record<string, string>;
    players: StatusPlayer[];
}

let latestStatus: StatusData | null = null;

const udpSock = dgram.createSocket('udp4');

/**
 * True when `rinfo` plausibly answers the status query sent to
 * `targetHost:targetPort` (defaults to the current live target). The port
 * must match the polled server; when the host is an IP literal the sender
 * address must match too (hostname targets rely on the port check —
 * comparing would need a DNS lookup).
 */
export function isStatusReplySource(
    rinfo: { port: number; address: string },
    targetHost = host,
    targetPort = port,
): boolean {
    if (rinfo.port !== targetPort) return false;
    if (net.isIP(targetHost) && rinfo.address !== targetHost) return false;
    return true;
}

udpSock.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    // Only accept replies from the host:port we actually poll — anything
    // else on this socket is unsolicited.
    if (!isStatusReplySource(rinfo)) return;

    // OOB packets start with 0xFFFFFFFF
    if (msg.length < 4 || msg[0] !== 0xff || msg[1] !== 0xff || msg[2] !== 0xff || msg[3] !== 0xff) return;

    const text = msg.subarray(4).toString('ascii');
    if (!text.startsWith('print\n')) return;

    const body = text.slice(6); // skip "print\n"
    const lines = body.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return;

    // First line: serverinfo (\key\value pairs)
    const serverinfo: Record<string, string> = {};
    const infoParts = lines[0].split('\\');
    // infoParts[0] is empty (leading backslash), then key, value, key, value...
    for (let i = 1; i + 1 < infoParts.length; i += 2) {
        serverinfo[infoParts[i]] = infoParts[i + 1];
    }

    // Remaining lines: frags ping "name"
    const statusPlayers: StatusPlayer[] = [];
    for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/^(-?\d+)\s+(\d+)\s+"(.+)"$/);
        if (m) {
            statusPlayers.push({ frags: parseInt(m[1], 10), ping: parseInt(m[2], 10), name: m[3] });
        }
    }

    latestStatus = { serverinfo, players: statusPlayers };
    console.log(`[status] ${statusPlayers.length} player(s) in server info`);
    sseBroadcast('status', latestStatus);
});

udpSock.on('error', (err) => {
    console.error(`[udp] Error: ${err.message}`);
});

function sendOOBStatus(): void {
    const header = Buffer.alloc(4, 0xff);
    const payload = Buffer.from('status\n', 'ascii');
    const packet = Buffer.concat([header, payload]);
    udpSock.send(packet, 0, packet.length, port, host);
}

// Trigger OOB status query every 30th frame (skipped while replaying a demo)
const origOnFrame2 = parser.onFrame;
parser.onFrame = (ev) => {
    origOnFrame2?.(ev);
    if (currentReplay) return;
    if (ev.frameNumber > 0 && ev.frameNumber % 30 === 0) {
        sendOOBStatus();
    }
};

// ── Replay plumbing ─────────────────────────────────────────────

const DEFAULT_DEMO = path.resolve(__dirname, '..', 'assets', 'demos', 'demo.mvd2');

function resetPipelineState(): void {
    parser.reset();
    configstrings.clear();
    players.clear();
    csExtended = false;
    combatFx.reset();
    stats.reset();
    if (statsTimer) {
        clearTimeout(statsTimer);
        statsTimer = null;
    }
    combatFx.notePlayers(players);
    chatLog.length = 0;
    killFeed.length = 0;
    scoreboard.teamScores = { team1: 0, team2: 0, team3: 0 };
    scoreboard.layoutsFlags = 0;
    scoreboard.layoutText = '';
    scoreboard.players = {};
    latestStatus = null;
}

/** JSON view of the active replay's playback state (null when idle). */
function replayStatePayload() {
    if (!currentReplay) return null;
    return {
        file: path.basename(currentReplayFile ?? ''),
        paused: currentReplay.paused,
        speed: currentReplay.speed,
        position: currentReplay.position,
        messageCount: currentReplay.messageCount,
    };
}

function broadcastReplayState(): void {
    const s = replayStatePayload();
    if (s) sseBroadcast('replayState', s);
}

function startReplay(filePath: string): void {
    resetPipelineState();
    const reader = new MvdDemoReader({ realtime: true, tickMs: 100 });
    currentReplay = reader;
    currentReplayFile = filePath;

    reader.on('message', (buf) => {
        try {
            parser.parse(buf);
        } catch (err) {
            console.error('[replay] Parse error, dropping frame:', err);
            parser.reset();
        }
    });
    reader.on('end', () => {
        console.log('[replay] End');
        currentReplay = null;
        currentReplayFile = null;
        sseBroadcast('replayEnd', {});
    });
    reader.on('error', (err) => {
        console.error('[replay] Error:', err.message);
        currentReplay = null;
        currentReplayFile = null;
        sseBroadcast('replayError', { message: err.message });
    });
    // A seek jumps to an earlier keyframe; everything derived from the stream
    // (configstrings, players, scoreboard, feeds) must rebuild from there.
    reader.on('seek', () => {
        resetPipelineState();
        broadcastReplayState();
    });
    reader.on('pause', broadcastReplayState);
    reader.on('resume', broadcastReplayState);

    sseBroadcast('replayStart', { file: filePath });
    console.log(`[replay] Starting ${filePath}`);
    reader.play(filePath);
}

function stopReplay(): boolean {
    if (!currentReplay) return false;
    currentReplay.stop();
    currentReplay = null;
    currentReplayFile = null;
    sseBroadcast('replayEnd', {});
    console.log('[replay] Stopped');
    return true;
}

// ── HTTP server ─────────────────────────────────────────────────

const MAPS_DIR = path.resolve(__dirname, '..', 'maps');
const TEXTURES_DIR = path.resolve(__dirname, '..', 'textures');
const COLORMAP_PATH = path.resolve(__dirname, '..', 'colormap.pcx');
const DEMOS_DIR = path.resolve(__dirname, '..', 'assets', 'demos');
const PAKS_DIR = path.resolve(__dirname, '..', 'paks');
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);
// Bind localhost by default — the control surface can open TCP/UDP to
// arbitrary hosts via /connect, so exposing it on the LAN is opt-in.
const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';

// ── Pak/Pkz asset fallback ──────────────────────────────────────
//
// Index every `.pak` / `.pkz` under `paks/` at startup. When a map or
// texture asset is missing under `maps/` / `textures/`, we materialize it
// from the indexed archives into a per-process overlay dir so that the
// existing buffer-based parsers (bsp.ts, wal.ts, map-render.ts) can be
// used unchanged.
const pakIndex = PakIndex.load(PAKS_DIR);
if (pakIndex.size > 0) {
    console.log(`[pak] Indexed ${pakIndex.size} entries from ${pakIndex.archives.length} archive(s) in ${PAKS_DIR}`);
} else if (fs.existsSync(PAKS_DIR)) {
    console.log(`[pak] No archives found in ${PAKS_DIR}`);
}

const PAK_OVERLAY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-mvd-pak-'));
const overlayMaterialized = new Set<string>();

function materializeFromPak(relPath: string): string | null {
    const norm = relPath.replace(/\\/g, '/').toLowerCase();
    const overlayPath = path.join(PAK_OVERLAY_DIR, norm);
    if (overlayMaterialized.has(norm)) {
        return overlayPath;
    }
    const buf = pakIndex.read(norm);
    if (!buf) return null;
    fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
    fs.writeFileSync(overlayPath, buf);
    overlayMaterialized.add(norm);
    return overlayPath;
}

/**
 * Build a textures-directory view that contains every wal texture referenced
 * by the given BSP, falling back to the pak index for any missing files.
 * If all required textures already exist under `TEXTURES_DIR` we return that
 * path directly; otherwise we ensure the overlay mirrors them and return
 * the overlay path.
 */
function prepareTexturesDir(bsp: BspFile): string {
    if (pakIndex.size === 0) return TEXTURES_DIR;
    const unique = new Set<string>();
    for (const t of bsp.texinfo) unique.add(t.name);

    // First pass: are any required wals missing from disk?
    let needOverlay = false;
    for (const name of unique) {
        if (!fs.existsSync(path.join(TEXTURES_DIR, name + '.wal'))) {
            needOverlay = true;
            break;
        }
    }
    if (!needOverlay) return TEXTURES_DIR;

    // Build a unified overlay: symlink fs-resident wals, extract missing
    // ones from the pak index. The overlay then satisfies all lookups via
    // a single directory passed to loadWalTexture().
    const overlayTex = path.join(PAK_OVERLAY_DIR, 'textures');
    for (const name of unique) {
        const overlayPath = path.join(overlayTex, name + '.wal');
        const norm = `textures/${name.toLowerCase()}.wal`;
        if (overlayMaterialized.has(norm)) continue;
        fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
        const fsPath = path.join(TEXTURES_DIR, name + '.wal');
        if (fs.existsSync(fsPath)) {
            try { fs.symlinkSync(fsPath, overlayPath); }
            catch { fs.copyFileSync(fsPath, overlayPath); }
            overlayMaterialized.add(norm);
            continue;
        }
        const buf = pakIndex.read(`textures/${name}.wal`);
        if (!buf) continue;
        fs.writeFileSync(overlayPath, buf);
        overlayMaterialized.add(norm);
    }
    return overlayTex;
}

function prepareColormap(): string {
    if (fs.existsSync(COLORMAP_PATH)) return COLORMAP_PATH;
    // Common Q2 layouts: pics/colormap.pcx (q2pro) or just colormap.pcx.
    const candidates = ['pics/colormap.pcx', 'colormap.pcx'];
    for (const rel of candidates) {
        const p = materializeFromPak(rel);
        if (p) return p;
    }
    return COLORMAP_PATH; // will likely fail, but keeps existing error path
}

const MAX_REQUEST_BODY = 4 * 1024;

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REQUEST_BODY) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function listDemos(): string[] {
    if (!fs.existsSync(DEMOS_DIR)) return [];
    return fs.readdirSync(DEMOS_DIR)
        .filter((name) => name.toLowerCase().endsWith('.mvd2'))
        .sort();
}

const bspCache = new Map<string, BspFile>();

function loadBsp(mapName: string): BspFile | null {
    if (bspCache.has(mapName)) return bspCache.get(mapName)!;
    const fsPath = path.join(MAPS_DIR, `${mapName}.bsp`);
    if (fs.existsSync(fsPath)) {
        const bsp = BspFile.loadFile(fsPath);
        bspCache.set(mapName, bsp);
        return bsp;
    }
    const buf = pakIndex.read(`maps/${mapName}.bsp`);
    if (!buf) return null;
    const bsp = BspFile.load(buf);
    bspCache.set(mapName, bsp);
    return bsp;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Control endpoints
    if (url.pathname === '/connect' && req.method === 'POST') {
        if (currentReplay) {
            sendJson(res, 409, { error: 'replay-active' });
            return;
        }
        if (client.state !== ClientState.Disconnected) {
            sendJson(res, 409, { error: 'already-connected', state: client.state });
            return;
        }
        readJsonBody(req).then((body) => {
            const b = (body ?? {}) as { host?: unknown; port?: unknown; password?: unknown };
            let nextHost = defaultHost;
            let nextPort = defaultPort;
            let nextPassword = '';
            if (b.host !== undefined) {
                if (typeof b.host !== 'string' || b.host.trim().length === 0) {
                    sendJson(res, 400, { error: 'invalid-host' });
                    return;
                }
                nextHost = b.host.trim();
            }
            if (b.port !== undefined) {
                const p = typeof b.port === 'number' ? b.port : parseInt(String(b.port), 10);
                if (!Number.isInteger(p) || p < 1 || p > 65535) {
                    sendJson(res, 400, { error: 'invalid-port' });
                    return;
                }
                nextPort = p;
            }
            if (b.password !== undefined) {
                if (typeof b.password !== 'string') {
                    sendJson(res, 400, { error: 'invalid-password' });
                    return;
                }
                nextPassword = b.password;
            }
            // Re-check after the async body read — a replay may have started
            // or a concurrent /connect may have won the race meanwhile.
            if (currentReplay) {
                sendJson(res, 409, { error: 'replay-active' });
                return;
            }
            // setTarget only succeeds while Disconnected; it is the atomic
            // gate that closes the check-then-connect TOCTOU.
            if (!client.setTarget(nextHost, nextPort, nextPassword)) {
                sendJson(res, 409, { error: 'already-connected', state: client.state });
                return;
            }
            host = nextHost;
            port = nextPort;
            client.connect();
            sendJson(res, 202, { state: client.state, host, port });
        }).catch((err: Error) => {
            sendJson(res, 400, { error: 'invalid-body', message: err.message });
        });
        return;
    }

    if (url.pathname === '/demos' && req.method === 'GET') {
        sendJson(res, 200, { demos: listDemos() });
        return;
    }

    if (url.pathname === '/disconnect' && req.method === 'POST') {
        client.disconnect();
        res.writeHead(204);
        res.end();
        return;
    }

    if (url.pathname === '/replay' && req.method === 'POST') {
        if (currentReplay) {
            sendJson(res, 409, { error: 'replay-active', file: currentReplayFile });
            return;
        }
        if (client.state !== ClientState.Disconnected) {
            sendJson(res, 409, { error: 'live-active', state: client.state });
            return;
        }
        const requested = url.searchParams.get('file');
        let filePath: string;
        if (!requested) {
            filePath = DEFAULT_DEMO;
        } else {
            // Confine to DEMOS_DIR — reject path separators / traversal.
            const base = path.basename(requested);
            if (base !== requested || requested.includes('\0')) {
                sendJson(res, 400, { error: 'invalid-file' });
                return;
            }
            filePath = path.resolve(DEMOS_DIR, base);
            if (filePath !== DEMOS_DIR && !filePath.startsWith(DEMOS_DIR + path.sep)) {
                sendJson(res, 400, { error: 'invalid-file' });
                return;
            }
        }
        if (!fs.existsSync(filePath)) {
            sendJson(res, 404, { error: 'not-found', file: path.basename(filePath) });
            return;
        }
        startReplay(filePath);
        sendJson(res, 202, { file: path.basename(filePath) });
        return;
    }

    if (url.pathname === '/replay' && req.method === 'DELETE') {
        stopReplay();
        res.writeHead(204);
        res.end();
        return;
    }

    // POST /replay/control — {pause?, speed?, seek?} applied in that order.
    // `seek` is a message index; it snaps back to the nearest keyframe and
    // the snapped position is reported in the response / replayState SSE.
    if (url.pathname === '/replay/control' && req.method === 'POST') {
        if (!currentReplay) {
            sendJson(res, 409, { error: 'no-replay' });
            return;
        }
        readJsonBody(req).then((body) => {
            if (!currentReplay) {
                sendJson(res, 409, { error: 'no-replay' });
                return;
            }
            const b = (body ?? {}) as { pause?: unknown; speed?: unknown; seek?: unknown };
            if (b.pause !== undefined) {
                if (typeof b.pause !== 'boolean') {
                    sendJson(res, 400, { error: 'invalid-pause' });
                    return;
                }
                if (b.pause) currentReplay.pause(); else currentReplay.resume();
            }
            if (b.seek !== undefined) {
                const s = typeof b.seek === 'number' ? b.seek : parseInt(String(b.seek), 10);
                if (!Number.isInteger(s) || s < 0) {
                    sendJson(res, 400, { error: 'invalid-seek' });
                    return;
                }
                currentReplay.seek(s);
            }
            if (b.speed !== undefined) {
                const v = typeof b.speed === 'number' ? b.speed : parseFloat(String(b.speed));
                if (!Number.isFinite(v) || v <= 0) {
                    sendJson(res, 400, { error: 'invalid-speed' });
                    return;
                }
                currentReplay.setSpeed(v);
            }
            const st = replayStatePayload();
            sseBroadcast('replayState', st);
            sendJson(res, 202, st);
        }).catch((err: Error) => {
            sendJson(res, 400, { error: 'invalid-body', message: err.message });
        });
        return;
    }

    // POST /record/start?name=foo — begin writing live stream to a .mvd2
    // under DEMOS_DIR so the result is immediately replayable via /replay.
    if (url.pathname === '/record/start' && req.method === 'POST') {
        const requested = url.searchParams.get('name');
        let base: string;
        if (!requested) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            base = `live-${stamp}.mvd2`;
        } else {
            // Confine to DEMOS_DIR — same traversal guard as /replay.
            base = path.basename(requested);
            if (base !== requested || requested.includes('\0')) {
                sendJson(res, 400, { error: 'invalid-name' });
                return;
            }
            if (!base.toLowerCase().endsWith('.mvd2')) {
                base += '.mvd2';
            }
        }
        if (recorder.recording) {
            sendJson(res, 409, { error: 'already-recording', file: path.basename(recorder.file) });
            return;
        }
        if (client.state !== ClientState.Streaming && client.state !== ClientState.Suspended) {
            sendJson(res, 409, { error: 'not-streaming', state: client.state });
            return;
        }
        const filePath = path.resolve(DEMOS_DIR, base);
        if (filePath !== DEMOS_DIR && !filePath.startsWith(DEMOS_DIR + path.sep)) {
            sendJson(res, 400, { error: 'invalid-name' });
            return;
        }
        try {
            recorder.open(filePath);
        } catch (err) {
            sendJson(res, 500, { error: 'open-failed', message: (err as Error).message });
            return;
        }
        const file = path.basename(filePath);
        console.log(`[record] Started → ${filePath}`);
        sseBroadcast('recordStart', { file });
        sendJson(res, 202, { file });
        return;
    }

    if (url.pathname === '/record/stop' && req.method === 'POST') {
        const fin = recorder.close();
        if (!fin) {
            sendJson(res, 404, { error: 'not-recording' });
            return;
        }
        const body = { file: path.basename(fin.file), messages: fin.messages, bytes: fin.bytes };
        console.log(`[record] Stopped (${fin.messages} messages → ${fin.file})`);
        sseBroadcast('recordStop', body);
        sendJson(res, 200, body);
        return;
    }

    if (url.pathname === '/paks' && req.method === 'GET') {
        sendJson(res, 200, {
            archives: pakIndex.archives,
            entryCount: pakIndex.size,
        });
        return;
    }

    if (url.pathname === '/state' && req.method === 'GET') {
        const mode = currentReplay
            ? 'replay'
            : client.state === ClientState.Disconnected
                ? 'idle'
                : 'live';
        sendJson(res, 200, {
            mode,
            clientState: client.state,
            replayFile: currentReplayFile,
            replay: replayStatePayload(),
            recording: recorder.recording
                ? { file: path.basename(recorder.file), messages: recorder.messages }
                : null,
        });
        return;
    }

    if (url.pathname === '/stats' && req.method === 'GET') {
        sendJson(res, 200, stats.snapshot());
        return;
    }

    // GET /maps/{mapname}
    const mapMatch = url.pathname.match(/^\/maps\/([\w.-]+)$/);
    if (mapMatch) {
        const mapName = mapMatch[1];
        try {
            const bsp = loadBsp(mapName);
            if (!bsp) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end(`Map not found: ${mapName}`);
                return;
            }
            const noTextures = url.searchParams.has('notextures');
            const texturesDir = noTextures ? undefined : prepareTexturesDir(bsp);
            const colormapPath = noTextures ? undefined : prepareColormap();
            const svg = generateMapSvg(bsp, mapName, {
                showGrid: url.searchParams.has('grid'),
                showMarkers: url.searchParams.has('markers'),
                texturesDir,
                colormapPath,
            });
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            res.end(svg);
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Error rendering map: ${err.message}`);
        }
        return;
    }

    // GET /events (SSE)
    if (url.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('\n');

        // Send current state snapshot
        const cs: Record<number, string> = {};
        for (const [k, v] of configstrings) cs[k] = v;
        const ps = Array.from(players.values()).map((p) => serializePlayerForSse(p));
        res.write(`event: snapshot\ndata: ${JSON.stringify({
            configstrings: cs,
            extended: csExtended,
            players: ps,
            status: latestStatus,
            chatLog,
            killFeed,
            scoreboard,
            replay: replayStatePayload(),
            stats: stats.snapshot(),
        })}\n\n`);

        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        res.on('error', () => sseClients.delete(res));
        return;
    }

    // Static file serving from public/
    const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
    const MIME_TYPES: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
    };

    const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
    // Reject path traversal; keep resolved path under PUBLIC_DIR.
    const filePath = path.resolve(PUBLIC_DIR, '.' + reqPath);
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
        return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        try {
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        } catch {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
        }
        return;
    }

    // SPA fallback: extensionless paths get index.html; paths with an
    // extension (e.g. missing .png) return a real 404.
    const basename = path.basename(reqPath);
    if (basename.includes('.')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
    }

    try {
        const content = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
});

// ── Public test/embed surface ───────────────────────────────────

export {
    httpServer,
    client,
    parser,
    sseClients,
    listDemos,
    startReplay,
    stopReplay,
    DEMOS_DIR,
    DEFAULT_DEMO,
    pakIndex,
    PAKS_DIR,
};

/** Snapshot of the in-memory scoreboard, for tests. */
export function getScoreboardForTests(): typeof scoreboard {
    return scoreboard;
}

/** Current stream-roster players map (dummy-filtered), for tests. */
export function getPlayersForTests(): Map<number, PlayerState> {
    return players;
}

/**
 * Reset all in-memory session state. Intended for test isolation so suites
 * can share the single module instance without bleed-through.
 */
export function resetAppStateForTests(): void {
    if (currentReplay) currentReplay.stop();
    currentReplay = null;
    currentReplayFile = null;
    recorder.close();
    client.disconnect();
    resetPipelineState();
}

// ── CLI bootstrap ───────────────────────────────────────────────

if (require.main === module) {
    httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
        console.log(`[http] Listening on http://${HTTP_HOST}:${HTTP_PORT}`);
        console.log(`[http]   GET  /maps/{name}  — SVG map render`);
        console.log(`[http]   GET  /events       — SSE stream`);
        console.log(`[http]   GET  /state        — current mode (idle/live/replay)`);
        console.log(`[http]   GET  /demos        — list demo filenames in assets/demos/`);
        console.log(`[http]   GET  /paks         — pak/pkz archives indexed at startup`);
        console.log(`[http]   POST /connect      — start live GTV (body: { host?, port?, password? }; defaults ${defaultHost}:${defaultPort})`);
        console.log(`[http]   POST /disconnect   — stop live GTV`);
        console.log(`[http]   POST /replay[?file=...] — replay a .mvd2 demo`);
        console.log(`[http]   POST /replay/control — {pause?, speed?, seek?} playback control`);
        console.log(`[http]   DEL  /replay       — stop active replay`);
        console.log(`[http]   POST /record/start?name=x.mvd2 — record live stream to assets/demos/`);
        console.log(`[http]   POST /record/stop   — finish the active recording`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nDisconnecting...');
        clearInterval(sseHeartbeat);
        currentReplay?.stop();
        httpServer.close();
        udpSock.close();
        client.disconnect();
        pakIndex.close();
        try {
            fs.rmSync(PAK_OVERLAY_DIR, { recursive: true, force: true });
        } catch { /* temp dir cleanup is best-effort */ }
        process.exit(0);
    });
}
