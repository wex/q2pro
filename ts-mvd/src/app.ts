import * as dgram from 'node:dgram';
import * as dns from 'node:dns';
import * as http from 'node:http';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientState } from './protocol';
import { Session, StatusData } from './session';
import { BspFile } from './bsp';
import { generateMapSvg } from './map-render';
import { PakIndex } from './pak';

const defaultHost = process.argv[2] || '127.0.0.1';
const defaultPort = parseInt(process.argv[3] || '27910', 10);

// ── SSE client management (shared across sessions) ──────────────

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

// ── OOB status polling via UDP (shared socket) ───────────────────

const udpSock = dgram.createSocket('udp4');

/**
 * The status query target we most recently polled, plus the addresses it
 * resolved to (`ips === null` while a hostname lookup is still in flight —
 * replies in that window fall back to the port check, see
 * isStatusReplySource). `session` is the Session that initiated the poll,
 * so replies land on the right `latestStatus`.
 */
const statusPoll = {
    host: '',
    port: 0,
    session: null as Session | null,
    ips: null as Set<string> | null,
};

/** Resolve the poll target's addresses for reply attribution. */
export function resolveStatusTargetIps(targetHost: string, targetPort: number): Promise<void> {
    statusPoll.host = targetHost;
    statusPoll.port = targetPort;
    if (net.isIP(targetHost)) {
        statusPoll.ips = new Set([targetHost]);
        return Promise.resolve();
    }
    statusPoll.ips = null;
    return new Promise((resolve) => {
        dns.lookup(targetHost, { all: true }, (err, addrs) => {
            if (!err && statusPoll.host === targetHost && statusPoll.port === targetPort) {
                statusPoll.ips = new Set(addrs.map((a) => a.address));
            }
            resolve();
        });
    });
}

function sendOOBStatus(targetHost: string, targetPort: number): void {
    statusPoll.session =
        [...sessions.values()].find((s) => s.host === targetHost && s.port === targetPort) ?? null;
    void resolveStatusTargetIps(targetHost, targetPort);
    const header = Buffer.alloc(4, 0xff);
    const payload = Buffer.from('status\n', 'ascii');
    const packet = Buffer.concat([header, payload]);
    udpSock.send(packet, 0, packet.length, targetPort, targetHost);
}

/**
 * True when `rinfo` plausibly answers the status query sent to
 * `targetHost:targetPort` (defaults to the last polled target). The port
 * must match; for an IP-literal host the sender address must match too.
 * For a hostname target the resolved address set is enforced once the
 * lookup has landed — until then the port check alone gates replies (a
 * brief window, documented in doc/app-hardening.md).
 */
export function isStatusReplySource(
    rinfo: { port: number; address: string },
    targetHost = statusPoll.host || sessions.get('default')!.host,
    targetPort = statusPoll.port || sessions.get('default')!.port,
): boolean {
    if (rinfo.port !== targetPort) return false;
    if (net.isIP(targetHost)) return rinfo.address === targetHost;
    if (
        statusPoll.host === targetHost &&
        statusPoll.port === targetPort &&
        statusPoll.ips !== null
    ) {
        return statusPoll.ips.has(rinfo.address);
    }
    return true;
}

// ── Sessions ─────────────────────────────────────────────────────

/**
 * Session map. The transport layer only exposes the 'default' session
 * today — global exclusivity (at most one live stream *or* one replay) is
 * enforced in the routes below, not per-session. See doc/session-refactor
 * groundwork in plan-81a931fe9b1c5b9b.md.
 */
const sessions = new Map<string, Session>();

function createSession(id: string, host: string, port: number): Session {
    const s = new Session(id, {
        host,
        port,
        broadcast: sseBroadcast,
        statusQuery: sendOOBStatus,
        clientOpts: {
            username: 'ts-mvd',
            password: '',
            autoReconnect: true,
            reconnectDelay: 5000,
        },
    });
    sessions.set(id, s);
    return s;
}

const defaultSession = createSession('default', defaultHost, defaultPort);

/** Resolve `?session=` to a Session, replying 404 for unknown ids. */
function sessionFor(url: URL, res: http.ServerResponse): Session | null {
    const id = url.searchParams.get('session');
    if (id === null) return defaultSession;
    const s = sessions.get(id);
    if (!s) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown-session', session: id }));
        return null;
    }
    return s;
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
    const statusPlayers: StatusData['players'] = [];
    for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/^(-?\d+)\s+(\d+)\s+"(.+)"$/);
        if (m) {
            statusPlayers.push({ frags: parseInt(m[1], 10), ping: parseInt(m[2], 10), name: m[3] });
        }
    }

    const session = statusPoll.session ?? defaultSession;
    session.latestStatus = { serverinfo, players: statusPlayers };
    console.log(`[status] ${statusPlayers.length} player(s) in server info`);
    sseBroadcast('status', { session: session.id, ...session.latestStatus });
});

udpSock.on('error', (err) => {
    console.error(`[udp] Error: ${err.message}`);
});

// ── HTTP server ─────────────────────────────────────────────────

const MAPS_DIR = path.resolve(__dirname, '..', 'maps');
const TEXTURES_DIR = path.resolve(__dirname, '..', 'textures');
const COLORMAP_PATH = path.resolve(__dirname, '..', 'colormap.pcx');
const DEMOS_DIR = path.resolve(__dirname, '..', 'assets', 'demos');
const DEFAULT_DEMO = path.resolve(DEMOS_DIR, 'demo.mvd2');
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

// ── Request guards (CSRF / DNS-rebinding hardening) ─────────────
//
// The control surface can open outbound connections (/connect) and write
// files (/record/*), so it must not be drivable from an arbitrary web page.
// Two cheap checks close that: a Host allow-list (stops DNS-rebinding reads
// *and* writes) and an Origin allow-list on requests that carry one.
//
// `new URL()` needs a syntactically valid base — a constant one also makes
// the host part of req.url irrelevant, which it already was (routing only
// ever reads pathname/searchParams).
const URL_BASE = 'http://ts-mvd.invalid';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);
// Operator-extended allow-list for non-local binds (comma-separated names).
const EXTRA_ALLOWED_HOSTS = new Set(
    (process.env.HTTP_ALLOWED_HOSTS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
);

function hostNameAllowed(name: string): boolean {
    let n = name.toLowerCase();
    if (n.endsWith('.')) n = n.slice(0, -1); // FQDN trailing dot
    return LOCAL_HOSTNAMES.has(n) || n === HTTP_HOST.toLowerCase() || EXTRA_ALLOWED_HOSTS.has(n);
}

/** Strip the port from a Host header value; returns the bare name or null. */
function parseHostHeader(host: string): string | null {
    const h = host.trim();
    if (!h) return null;
    const v6 = h.match(/^\[([0-9a-fA-F:]+)\](?::\d+)?$/);
    if (v6) return v6[1];
    if (h.includes('[') || (h.match(/:/g) ?? []).length > 1) return null; // junk / unbracketed v6
    const colon = h.lastIndexOf(':');
    const name = colon === -1 ? h : h.slice(0, colon);
    if (!name || /[\s/?#@]/.test(name)) return null;
    return name;
}

/** DNS-rebinding guard: the Host header must name this server. */
function requestHostAllowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    if (host === undefined) return true; // HTTP/1.0 — a browser always sends Host
    const name = parseHostHeader(host);
    return name !== null && hostNameAllowed(name);
}

/** CSRF guard: a present Origin must resolve to an allowed host. */
function requestOriginAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined || origin === 'null') return true;
    try {
        const o = new URL(origin);
        if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
        return hostNameAllowed(o.hostname);
    } catch {
        return false;
    }
}

/**
 * JSON routes require `Content-Type: application/json` when a body is sent
 * (browsers can only produce it via fetch+CORS-safe request, so this also
 * hardens against form POSTs). Bodyless posts stay allowed for curl.
 */
function jsonContentTypeOk(req: http.IncomingMessage): boolean {
    const hasBody =
        (req.headers['content-length'] ?? '0') !== '0' ||
        req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) return true;
    const ct = req.headers['content-type'];
    if (!ct) return false;
    return ct.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

const httpServer = http.createServer((req, res) => {
    if (!requestHostAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden-host' });
        return;
    }
    if (!requestOriginAllowed(req)) {
        sendJson(res, 403, { error: 'forbidden-origin' });
        return;
    }
    let url: URL;
    try {
        url = new URL(req.url || '/', URL_BASE);
    } catch {
        sendJson(res, 400, { error: 'bad-request' });
        return;
    }

    // Control endpoints
    if (url.pathname === '/connect' && req.method === 'POST') {
        const session = sessionFor(url, res);
        if (!session) return;
        if (session.currentReplay) {
            sendJson(res, 409, { error: 'replay-active' });
            return;
        }
        if (session.client.state !== ClientState.Disconnected) {
            sendJson(res, 409, { error: 'already-connected', state: session.client.state });
            return;
        }
        if (!jsonContentTypeOk(req)) {
            sendJson(res, 415, { error: 'unsupported-media-type' });
            req.resume();
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
            if (session.currentReplay) {
                sendJson(res, 409, { error: 'replay-active' });
                return;
            }
            // setTarget only succeeds while Disconnected; it is the atomic
            // gate that closes the check-then-connect TOCTOU.
            if (!session.client.setTarget(nextHost, nextPort, nextPassword)) {
                sendJson(res, 409, { error: 'already-connected', state: session.client.state });
                return;
            }
            session.host = nextHost;
            session.port = nextPort;
            session.client.connect();
            sendJson(res, 202, { state: session.client.state, host: session.host, port: session.port });
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
        const session = sessionFor(url, res);
        if (!session) return;
        session.client.disconnect();
        res.writeHead(204);
        res.end();
        return;
    }

    if (url.pathname === '/replay' && req.method === 'POST') {
        const session = sessionFor(url, res);
        if (!session) return;
        if (session.currentReplay) {
            sendJson(res, 409, { error: 'replay-active', file: session.currentReplayFile });
            return;
        }
        if (session.client.state !== ClientState.Disconnected) {
            sendJson(res, 409, { error: 'live-active', state: session.client.state });
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
        session.startReplay(filePath);
        sendJson(res, 202, { file: path.basename(filePath) });
        return;
    }

    if (url.pathname === '/replay' && req.method === 'DELETE') {
        const session = sessionFor(url, res);
        if (!session) return;
        session.stopReplay();
        res.writeHead(204);
        res.end();
        return;
    }

    // POST /replay/control — {pause?, speed?, seek?} applied in that order.
    // `seek` is a message index; it snaps back to the nearest keyframe and
    // the snapped position is reported in the response / replayState SSE.
    if (url.pathname === '/replay/control' && req.method === 'POST') {
        const session = sessionFor(url, res);
        if (!session) return;
        if (!session.currentReplay) {
            sendJson(res, 409, { error: 'no-replay' });
            return;
        }
        if (!jsonContentTypeOk(req)) {
            sendJson(res, 415, { error: 'unsupported-media-type' });
            req.resume();
            return;
        }
        readJsonBody(req).then((body) => {
            const replay = session.currentReplay;
            if (!replay) {
                sendJson(res, 409, { error: 'no-replay' });
                return;
            }
            const b = (body ?? {}) as { pause?: unknown; speed?: unknown; seek?: unknown };
            if (b.pause !== undefined) {
                if (typeof b.pause !== 'boolean') {
                    sendJson(res, 400, { error: 'invalid-pause' });
                    return;
                }
                if (b.pause) replay.pause(); else replay.resume();
            }
            if (b.seek !== undefined) {
                const s = typeof b.seek === 'number' ? b.seek : parseInt(String(b.seek), 10);
                if (!Number.isInteger(s) || s < 0) {
                    sendJson(res, 400, { error: 'invalid-seek' });
                    return;
                }
                replay.seek(s);
            }
            if (b.speed !== undefined) {
                const v = typeof b.speed === 'number' ? b.speed : parseFloat(String(b.speed));
                if (!Number.isFinite(v) || v <= 0) {
                    sendJson(res, 400, { error: 'invalid-speed' });
                    return;
                }
                replay.setSpeed(v);
            }
            const st = session.replayStatePayload();
            sseBroadcast('replayState', { session: session.id, ...st });
            sendJson(res, 202, st);
        }).catch((err: Error) => {
            sendJson(res, 400, { error: 'invalid-body', message: err.message });
        });
        return;
    }

    // POST /record/start?name=foo — begin writing live stream to a .mvd2
    // under DEMOS_DIR so the result is immediately replayable via /replay.
    if (url.pathname === '/record/start' && req.method === 'POST') {
        const session = sessionFor(url, res);
        if (!session) return;
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
        if (session.recorder.recording) {
            sendJson(res, 409, { error: 'already-recording', file: path.basename(session.recorder.file) });
            return;
        }
        if (session.client.state !== ClientState.Streaming && session.client.state !== ClientState.Suspended) {
            sendJson(res, 409, { error: 'not-streaming', state: session.client.state });
            return;
        }
        const filePath = path.resolve(DEMOS_DIR, base);
        if (filePath !== DEMOS_DIR && !filePath.startsWith(DEMOS_DIR + path.sep)) {
            sendJson(res, 400, { error: 'invalid-name' });
            return;
        }
        try {
            session.recorder.open(filePath);
        } catch (err) {
            sendJson(res, 500, { error: 'open-failed', message: (err as Error).message });
            return;
        }
        const file = path.basename(filePath);
        console.log(`[record] Started → ${filePath}`);
        sseBroadcast('recordStart', { session: session.id, file });
        sendJson(res, 202, { file });
        return;
    }

    if (url.pathname === '/record/stop' && req.method === 'POST') {
        const session = sessionFor(url, res);
        if (!session) return;
        const fin = session.recorder.close();
        if (!fin) {
            sendJson(res, 404, { error: 'not-recording' });
            return;
        }
        const body = { file: path.basename(fin.file), messages: fin.messages, bytes: fin.bytes };
        console.log(`[record] Stopped (${fin.messages} messages → ${fin.file})`);
        sseBroadcast('recordStop', { session: session.id, ...body });
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
        const session = sessionFor(url, res);
        if (!session) return;
        sendJson(res, 200, {
            session: session.id,
            sessions: Array.from(sessions.keys()),
            mode: session.mode,
            clientState: session.client.state,
            replayFile: session.currentReplayFile,
            replay: session.replayStatePayload(),
            recording: session.recorder.recording
                ? { file: path.basename(session.recorder.file), messages: session.recorder.messages }
                : null,
        });
        return;
    }

    if (url.pathname === '/stats' && req.method === 'GET') {
        const session = sessionFor(url, res);
        if (!session) return;
        sendJson(res, 200, { session: session.id, ...session.stats.snapshot() });
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
        const session = sessionFor(url, res);
        if (!session) return;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('\n');

        // Send current state snapshot
        res.write(`event: snapshot\ndata: ${JSON.stringify(session.snapshot())}\n\n`);

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
    sessions,
    defaultSession,
    createSession,
    sseClients,
    listDemos,
    DEMOS_DIR,
    DEFAULT_DEMO,
    pakIndex,
    PAKS_DIR,
};

// Back-compat aliases — the pre-Session test surface.
export const client = defaultSession.client;
export const parser = defaultSession.parser;
export const startReplay = (filePath: string) => defaultSession.startReplay(filePath);
export const stopReplay = () => defaultSession.stopReplay();

/** Snapshot of the in-memory scoreboard, for tests. */
export function getScoreboardForTests(): typeof defaultSession.scoreboard {
    return defaultSession.scoreboard;
}

/** Current stream-roster players map (dummy-filtered), for tests. */
export function getPlayersForTests() {
    return defaultSession.players;
}

/**
 * Reset all in-memory session state. Intended for test isolation so suites
 * can share the single module instance without bleed-through.
 */
export function resetAppStateForTests(): void {
    for (const s of sessions.values()) {
        if (s.currentReplay) s.currentReplay.stop();
        s.currentReplay = null;
        s.currentReplayFile = null;
        s.recorder.close();
        s.client.disconnect();
        s.resetPipelineState();
    }
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
        console.log(`[http]   GET  /stats        — per-round match stats`);
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
        for (const s of sessions.values()) {
            s.currentReplay?.stop();
            s.client.disconnect();
        }
        httpServer.close();
        udpSock.close();
        pakIndex.close();
        try {
            fs.rmSync(PAK_OVERLAY_DIR, { recursive: true, force: true });
        } catch { /* temp dir cleanup is best-effort */ }
        process.exit(0);
    });
}
