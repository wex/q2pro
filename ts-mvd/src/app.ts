import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MvdClient } from './index';
import { MvdDemoReader } from './demo';
import { ClientState, Stat } from './protocol';
import {
    MvdFrameParser,
    PlayerState,
    ChatEvent,
    ObituaryEvent,
    HitEvent,
    HitTakenEvent,
    LayoutEvent,
    MuzzleFlashEvent,
    TempEntityEvent,
    TeamScores,
    DeathEvent,
} from './frame';
import { BspFile } from './bsp';
import { generateMapSvg } from './map-render';
import { CombatFxResolver } from './combat-fx';

const defaultHost = process.argv[2] || '127.0.0.1';
const defaultPort = parseInt(process.argv[3] || '27910', 10);

// Live GTV target; mutated by POST /connect so the UI can pick host/port.
let host = defaultHost;
let port = defaultPort;

const client = new MvdClient({
    host,
    port,
    username: 'ts-mvd',
    password: 'aq2world',
    autoReconnect: true,
    reconnectDelay: 5000,
});

// Active demo replay, if any. When non-null, live GTV is expected to be idle
// and UDP OOB polling is skipped.
let currentReplay: MvdDemoReader | null = null;
let currentReplayFile: string | null = null;

const parser = new MvdFrameParser();

const configstrings = new Map<number, string>();
const players = new Map<number, PlayerState>();

const combatFx = new CombatFxResolver();
combatFx.notePlayers(players);

// ── Chat / kill-feed / scoreboard state ─────────────────────────

const CHAT_LOG_MAX = 200;
const KILL_FEED_MAX = 50;

interface ChatEntry extends ChatEvent { t: number }
interface KillEntry extends ObituaryEvent { t: number }

const chatLog: ChatEntry[] = [];
const killFeed: KillEntry[] = [];
const scoreboard = {
    teamScores: { team1: 0, team2: 0, team3: 0 } as TeamScores,
    layoutsFlags: 0,
    layoutText: '' as string,
    players: {} as Record<number, { number: number; frags: number }>,
};

parser.onServerData = (ev) => {
    configstrings.clear();
    players.clear();
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

parser.onConfigString = (ev) => {
    configstrings.set(ev.index, ev.value);
    console.log(`[configstring ${ev.index}] "${ev.value}"`);
};

parser.onFrame = (ev) => {
    if (ev.players.length === 0) return;

    const lines = ev.players.map((p) => {
        const pos = MvdFrameParser.originToWorld(p.origin);
        const x = pos[0].toFixed(1);
        const y = pos[1].toFixed(1);
        const z = pos[2].toFixed(1);
        const pitch = p.viewangles[0].toFixed(1);
        const yaw = p.viewangles[1].toFixed(1);
        return `  #${p.number} pos=(${x}, ${y}, ${z}) angles=(${pitch}, ${yaw})`;
    });

    // Update players map
    players.clear();
    for (const p of ev.players) {
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
    try {
        parser.parse(data);
    } catch (err) {
        console.error('[parse] Error parsing stream data, dropping frame:', err);
        parser.reset();
    }
});

client.on('streamResume', (data) => {
    console.log(`[stream] Resumed`);
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
    sseBroadcast('liveStop', {});
});

// ── SSE client management ───────────────────────────────────────

const sseClients = new Set<http.ServerResponse>();

function sseBroadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
        res.write(payload);
    }
}

// Broadcast player state on every frame
const origOnFrame = parser.onFrame;
parser.onFrame = (ev) => {
    origOnFrame?.(ev);

    // Keep the scoreboard in sync with live stats.
    scoreboard.teamScores = ev.teamScores;
    scoreboard.layoutsFlags = ev.layoutsFlags;
    const sbPlayers: Record<number, { number: number; frags: number }> = {};
    for (const p of ev.players) {
        sbPlayers[p.number] = { number: p.number, frags: p.frags };
    }
    scoreboard.players = sbPlayers;

    sseBroadcast('frame', {
        frameNumber: ev.frameNumber,
        players: ev.players.map((p) => {
            const pos = MvdFrameParser.originToWorld(p.origin);
            return {
                number: p.number,
                origin: pos,
                viewangles: p.viewangles,
                fov: p.fov,
                gunindex: p.gunindex,
                frags: p.frags,
                health: p.stats.length > Stat.Health ? p.stats[Stat.Health] : undefined,
            };
        }),
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
        gamedir: ev.gamedir,
        clientNum: ev.clientNum,
        configstrings: cs,
    });
};

const origOnConfigString = parser.onConfigString;
parser.onConfigString = (ev) => {
    origOnConfigString?.(ev);
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
};

parser.onHit = (ev: HitEvent) => {
    sseBroadcast('hit', { kind: 'dealt', ...ev });
};

parser.onHitTaken = (ev: HitTakenEvent) => {
    sseBroadcast('hit', { kind: 'taken', ...ev });
};

parser.onDeath = (ev: DeathEvent) => {
    sseBroadcast('death', { clientNum: ev.clientNum, origin: ev.origin, t: Date.now() });
};

parser.onLayout = (ev: LayoutEvent) => {
    scoreboard.layoutText = ev.text;
    sseBroadcast('layout', ev);
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

udpSock.on('message', (msg: Buffer) => {
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
    combatFx.reset();
    combatFx.notePlayers(players);
    chatLog.length = 0;
    killFeed.length = 0;
    scoreboard.teamScores = { team1: 0, team2: 0, team3: 0 };
    scoreboard.layoutsFlags = 0;
    scoreboard.layoutText = '';
    scoreboard.players = {};
    latestStatus = null;
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
const DEMOS_DIR = path.resolve(__dirname, '..', 'assets', 'demos');
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

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
    const filePath = path.join(MAPS_DIR, `${mapName}.bsp`);
    if (!fs.existsSync(filePath)) return null;
    const bsp = BspFile.loadFile(filePath);
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
            const b = (body ?? {}) as { host?: unknown; port?: unknown };
            let nextHost = defaultHost;
            let nextPort = defaultPort;
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
            host = nextHost;
            port = nextPort;
            client.setTarget(host, port);
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
        } else if (!requested.includes('/') && !requested.includes('\\')) {
            // Bare filename: resolve under assets/demos/.
            filePath = path.join(DEMOS_DIR, requested);
        } else {
            filePath = path.resolve(__dirname, '..', requested);
        }
        if (!fs.existsSync(filePath)) {
            sendJson(res, 404, { error: 'not-found', file: filePath });
            return;
        }
        startReplay(filePath);
        sendJson(res, 202, { file: filePath });
        return;
    }

    if (url.pathname === '/replay' && req.method === 'DELETE') {
        stopReplay();
        res.writeHead(204);
        res.end();
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
        });
        return;
    }

    // GET /maps/{mapname}
    const mapMatch = url.pathname.match(/^\/maps\/([\w.-]+)$/);
    if (mapMatch) {
        const mapName = mapMatch[1];
        const bsp = loadBsp(mapName);
        if (!bsp) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end(`Map not found: ${mapName}`);
            return;
        }
        try {
            const texturesDir = path.resolve(__dirname, '..', 'textures');
            const colormapPath = path.resolve(__dirname, '..', 'colormap.pcx');
            const svg = generateMapSvg(bsp, mapName, { showGrid: url.searchParams.has('grid'), texturesDir, colormapPath });
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
        const ps = Array.from(players.values()).map((p) => {
            const pos = MvdFrameParser.originToWorld(p.origin);
            return { number: p.number, origin: pos, viewangles: p.viewangles, fov: p.fov, gunindex: p.gunindex };
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify({
            configstrings: cs,
            players: ps,
            status: latestStatus,
            chatLog,
            killFeed,
            scoreboard,
        })}\n\n`);

        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // Static file serving from public/
    const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
    const MIME_TYPES: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
    };

    let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = path.join(PUBLIC_DIR, 'index.html');
    }

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
});

// ── Public test/embed surface ───────────────────────────────────

export {
    httpServer,
    client,
    parser,
    listDemos,
    startReplay,
    stopReplay,
    DEMOS_DIR,
    DEFAULT_DEMO,
};

/**
 * Reset all in-memory session state. Intended for test isolation so suites
 * can share the single module instance without bleed-through.
 */
export function resetAppStateForTests(): void {
    if (currentReplay) currentReplay.stop();
    currentReplay = null;
    currentReplayFile = null;
    client.disconnect();
    resetPipelineState();
}

// ── CLI bootstrap ───────────────────────────────────────────────

if (require.main === module) {
    httpServer.listen(HTTP_PORT, () => {
        console.log(`[http] Listening on http://localhost:${HTTP_PORT}`);
        console.log(`[http]   GET  /maps/{name}  — SVG map render`);
        console.log(`[http]   GET  /events       — SSE stream`);
        console.log(`[http]   GET  /state        — current mode (idle/live/replay)`);
        console.log(`[http]   GET  /demos        — list demo filenames in assets/demos/`);
        console.log(`[http]   POST /connect      — start live GTV (body: { host?, port? }; defaults ${defaultHost}:${defaultPort})`);
        console.log(`[http]   POST /disconnect   — stop live GTV`);
        console.log(`[http]   POST /replay[?file=...] — replay a .mvd2 demo`);
        console.log(`[http]   DEL  /replay       — stop active replay`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nDisconnecting...');
        currentReplay?.stop();
        httpServer.close();
        udpSock.close();
        client.disconnect();
        process.exit(0);
    });
}
