import { Q2Client } from './client.js';
import { ConnState, PrintLevel } from './protocol.js';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage: npx tsx src/index.ts <host[:port]> [name]');
  console.log('');
  console.log('Example: npx tsx src/index.ts 192.168.1.100:27910 MyBot');
  process.exit(1);
}

const [hostPort, playerName] = args;
let host: string;
let port: number;

if (hostPort.includes(':')) {
  const parts = hostPort.split(':');
  host = parts[0];
  port = parseInt(parts[1], 10);
} else {
  host = hostPort;
  port = 27910;
}

const client = new Q2Client({
  host,
  port,
  name: playerName ?? 'TSClient',
});

// Log events
client.on('log', (msg: string) => {
  console.log(`[Q2] ${msg}`);
});

client.on('print', (level: PrintLevel, text: string) => {
  const prefix = ['LOW', 'MED', 'HIGH', 'CHAT'][level] ?? 'UNK';
  process.stdout.write(`[${prefix}] ${text}`);
});

client.on('centerprint', (text: string) => {
  console.log(`[CENTER] ${text}`);
});

client.on('stufftext', (text: string) => {
  console.log(`[STUFF] ${text.trim()}`);
});

client.on('serverdata', (data: { levelname: string; gamedir: string; clientnum: number }) => {
  console.log(`[MAP] ${data.levelname} (gamedir: ${data.gamedir}, slot: ${data.clientnum})`);
});

client.on('active', () => {
  console.log('[Q2] === IN GAME ===');
  console.log('[Q2] Type messages to chat, or /cmd to send commands. Ctrl+C to quit.');
});

client.on('frame', (frame: { number: number }) => {
  // periodic status (every 100 frames)
  if (frame.number % 100 === 0) {
    const ps = client.currentPlayerState;
    const origin = ps.pmove.origin.map(v => (v / 8).toFixed(1));
    console.log(`[FRAME ${frame.number}] pos=(${origin.join(', ')})`);
  }
});

client.on('disconnect', () => {
  console.log('[Q2] Disconnected');
  process.exit(0);
});

client.on('error', (err: Error) => {
  console.error('[Q2] Error:', err.message);
});

// Interactive input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '',
});

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (client.connectionState !== ConnState.Active) {
    console.log('[Q2] Not connected yet...');
    return;
  }

  if (trimmed.startsWith('/')) {
    // send as raw command
    client.sendCommand(trimmed.substring(1));
  } else {
    // send as chat
    client.say(trimmed);
  }
});

rl.on('close', () => {
  client.disconnect();
  process.exit(0);
});

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n[Q2] Shutting down...');
  client.disconnect();
  process.exit(0);
});

// Start connection
client.connect();
