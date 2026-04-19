import { MvdClient, ClientState, MvdOp, SVCMD_MASK, SVCMD_BITS } from './index';
import { BufferReader } from './buffer';

const host = process.argv[2] || '127.0.0.1';
const port = parseInt(process.argv[3] || '27910', 10);

const client = new MvdClient({
    host,
    port,
    username: 'ts-mvd',
    password: '',
    deflate: true,
    autoReconnect: true,
    reconnectDelay: 5000,
});

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
    // Parse the first command byte from the MVD stream to show what's inside
    if (data.length > 0) {
        const cmd = data[0] & SVCMD_MASK;
        const extra = data[0] >> SVCMD_BITS;
        const opName = MvdOp[cmd] || `unknown(${cmd})`;
        console.log(`[data] ${data.length} bytes, first op: ${opName} (extra=${extra})`);

        // If it's a serverdata message, extract basic info
        if (cmd === MvdOp.ServerData) {
            parseServerData(data);
        }
    }
});

client.on('streamSuspend', () => {
    console.log('[stream] Suspended (no active players)');
});

client.on('streamResume', (data) => {
    console.log(`[stream] Resumed with ${data.length} bytes`);
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

function parseServerData(data: Buffer): void {
    try {
        const reader = new BufferReader(data);
        reader.readUInt8(); // skip command byte

        const protocol = reader.readInt32LE();
        const version = reader.readUInt16LE();

        let flags = 0;
        if (version >= 2012) {
            flags = reader.readUInt16LE();
        }

        const spawncount = reader.readInt32LE();
        const gamedir = reader.readString();
        const clientNum = reader.readInt16LE();

        console.log(`  [serverdata] protocol=${protocol} version=${version} flags=0x${flags.toString(16)}`);
        console.log(`  [serverdata] spawncount=${spawncount} gamedir="${gamedir}" clientNum=${clientNum}`);

        // Read a few configstrings to show map name etc.
        let count = 0;
        while (reader.remaining > 2 && count < 5) {
            const index = reader.readUInt16LE();
            if (index >= 4096) break; // sentinel
            const value = reader.readString();
            if (value) {
                console.log(`  [configstring] ${index}: "${value}"`);
            }
            count++;
        }
    } catch (e) {
        console.log('  [serverdata] (parse error, partial data shown above)');
    }
}

console.log(`Connecting to ${host}:${port}...`);
client.connect();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    client.disconnect();
    process.exit(0);
});
