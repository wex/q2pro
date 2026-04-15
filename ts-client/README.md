# Q2 TypeScript Client

A Quake 2 protocol 34 client implementation in TypeScript. Connects to
standard Quake 2 servers using the original network protocol, handles the
full connection handshake, parses server messages, and sends movement
commands.

## Requirements

- Node.js 18+
- A running Quake 2 server (protocol 34)

## Install

```bash
npm install
```

## Usage

### CLI

```bash
npx tsx src/index.ts <host[:port]> [name]
```

**Examples:**

```bash
# Connect to a local server
npx tsx src/index.ts 127.0.0.1

# Connect with a custom name and port
npx tsx src/index.ts 192.168.1.100:27910 MyBot
```

Once connected:
- Type text and press Enter to chat
- Prefix with `/` to send raw commands (e.g., `/kill`, `/wave`)
- Press Ctrl+C to disconnect

### Library

```typescript
import { Q2Client } from './client.js';

const client = new Q2Client({
  host: '127.0.0.1',
  port: 27910,
  name: 'Bot',
});

client.on('log', (msg) => console.log(msg));
client.on('print', (level, text) => console.log(text));
client.on('active', () => {
  console.log('In game!');
  client.say('Hello from TypeScript!');
});
client.on('frame', (frame) => {
  // called every server frame (~10 Hz)
});

client.connect();
```

## Architecture

```
src/
├── index.ts      — CLI entry point
├── client.ts     — Q2Client class (connection state machine, event emitter)
├── netchan.ts    — NETCHAN_OLD sequenced reliable datagram layer
├── parse.ts      — Server message parser (svc_* opcodes, delta decoding)
├── buffer.ts     — Little-endian binary BufferReader / BufferWriter
├── crc.ts        — COM_BlockSequenceCRCByte (move command checksum)
└── protocol.ts   — Constants, enums, and type definitions
```

## Protocol Coverage

This implementation covers the **protocol 34** (standard Quake 2) wire
format:

- **Connection handshake:** `getchallenge` → `challenge` → `connect` →
  `client_connect` → `new` → `svc_serverdata` → `begin`
- **Netchan:** NETCHAN_OLD with 16-bit qport, reliable message delivery,
  sequence numbering, drop detection
- **Server messages:** `svc_serverdata`, `svc_configstring`,
  `svc_spawnbaseline`, `svc_frame`, `svc_playerinfo`,
  `svc_packetentities`, `svc_print`, `svc_stufftext`, `svc_centerprint`,
  `svc_sound`, `svc_inventory`, `svc_layout`, `svc_muzzleflash`,
  `svc_disconnect`, `svc_reconnect`, `svc_nop`
- **Client messages:** `clc_move` (with CRC checksum), `clc_stringcmd`,
  `clc_nop`
- **Delta encoding:** Entity state (U_ flags), player state (PS_ flags),
  usercmd (CM_ flags)

## Limitations

- Protocol 34 only (no R1Q2/Q2PRO/AQtion enhanced protocols)
- No game-level prediction or interpolation
- Temp entity parsing is incomplete (returns on unknown TE type)
- No file download support
- No demo recording
