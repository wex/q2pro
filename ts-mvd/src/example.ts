import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MvdClient } from './index';
import { MvdFrameParser, PlayerState } from './frame';
import { BspFile } from './bsp';
import { generateMapSvg } from './map-render';

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '27910', 10);

const client = new MvdClient({
    host,
    port,
    username: 'ts-mvd',
    password: 'aq2world',
    autoReconnect: true,
    reconnectDelay: 5000,
});

const parser = new MvdFrameParser();

const configstrings = new Map<number, string>();
const players = new Map<number, PlayerState>();

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

    console.log(`[frame ${ev.frameNumber}] ${ev.players.length} player(s)`);
    lines.forEach((l) => console.log(l));
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
            };
        }),
    });
};

const origOnServerData = parser.onServerData;
parser.onServerData = (ev) => {
    origOnServerData?.(ev);
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

// Trigger OOB status query every 30th frame
const origOnFrame2 = parser.onFrame;
parser.onFrame = (ev) => {
    origOnFrame2?.(ev);
    if (ev.frameNumber > 0 && ev.frameNumber % 30 === 0) {
        sendOOBStatus();
    }
};

// ── HTTP server ─────────────────────────────────────────────────

const MAPS_DIR = path.resolve(__dirname, '..', 'maps');
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

const bspCache = new Map<string, BspFile>();

function loadBsp(mapName: string): BspFile | null {
    if (bspCache.has(mapName)) return bspCache.get(mapName)!;
    const filePath = path.join(MAPS_DIR, `${mapName}.bsp`);
    if (!fs.existsSync(filePath)) return null;
    const bsp = BspFile.loadFile(filePath);
    bspCache.set(mapName, bsp);
    return bsp;
}

const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

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
        res.write(`event: snapshot\ndata: ${JSON.stringify({ configstrings: cs, players: ps, status: latestStatus })}\n\n`);

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

httpServer.listen(HTTP_PORT, () => {
    console.log(`[http] Listening on http://localhost:${HTTP_PORT}`);
    console.log(`[http]   GET /maps/{name}  — SVG map render`);
    console.log(`[http]   GET /events       — SSE stream`);
});

console.log(`Connecting to ${host}:${port}...`);
client.connect();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    httpServer.close();
    udpSock.close();
    client.disconnect();
    process.exit(0);
});
