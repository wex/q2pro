import { MvdClient } from './index';
import { MvdFrameParser, PlayerState } from './frame';

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '27910', 10);

const client = new MvdClient({
    host,
    port,
    username: 'ts-mvd',
    password: 'aq2world',
    deflate: true,
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
    parser.parse(data);
});

client.on('streamResume', (data) => {
    console.log(`[stream] Resumed`);
    parser.parse(data);
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

console.log(`Connecting to ${host}:${port}...`);
client.connect();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    client.disconnect();
    process.exit(0);
});
