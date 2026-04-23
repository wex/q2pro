# ts-mvd

TypeScript MVD/GTV client for Q2Pro servers. Connects to a Q2Pro game server's
GTV TCP port, handles the full connection lifecycle automatically, and emits
typed events for each server opcode.

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Usage

```typescript
import { MvdClient, ClientState, MvdOp, SVCMD_MASK } from 'ts-mvd';

const client = new MvdClient({
    host: '127.0.0.1',
    port: 27910,
    username: 'spectator',
    password: '',
    deflate: true,        // request zlib compression
    autoReconnect: true,  // reconnect on disconnect
});

// Connection lifecycle events
client.on('connect', () => console.log('Magic exchanged'));
client.on('hello', (flags) => console.log('Hello, flags:', flags));
client.on('streamStart', () => console.log('Streaming'));

// MVD stream data
client.on('streamData', (data) => {
    const cmd = data[0] & SVCMD_MASK;
    console.log('MVD op:', MvdOp[cmd], 'size:', data.length);
});

// Stream suspend/resume (no active players on server)
client.on('streamSuspend', () => console.log('Suspended'));
client.on('streamResume', (data) => console.log('Resumed'));

// Errors and disconnect
client.on('error', ({ code, message }) => console.error(code, message));
client.on('disconnect', ({ reason }) => console.log('Disconnected:', reason));
client.on('close', () => console.log('Socket closed'));

// State machine transitions
client.on('stateChange', ({ from, to }) => console.log(from, '->', to));

client.connect();
```

## Run Example

```bash
npx ts-node src/example.ts [host] [port]
```

## Demo Playback

Stream a local `.mvd2` file through the same `MvdFrameParser` used for live
GTV connections.

```typescript
import { MvdDemoReader, MvdFrameParser } from 'ts-mvd';

const parser = new MvdFrameParser();
parser.onFrame = (ev) => console.log('frame', ev.frameNumber);

new MvdDemoReader({ realtime: true })
    .on('message', (buf) => parser.parse(buf))
    .play('assets/demos/demo.mvd2');
```

### Replay over SSE

`npm run app` starts the HTTP/SSE server in **idle** mode — no live GTV
connection is opened. Open `http://localhost:8080/` in a browser to use the
built-in chooser (Connect / Replay), or drive the control endpoints directly:

```bash
curl -X POST   http://localhost:8080/replay            # default assets/demos/demo.mvd2
curl -X POST   'http://localhost:8080/replay?file=foo.mvd2'   # bare name → assets/demos/
curl -X DELETE http://localhost:8080/replay
curl -X POST   -H 'content-type: application/json' \
     -d '{"host":"example.com","port":27910}' \
     http://localhost:8080/connect                     # live GTV with explicit target
curl -X POST   http://localhost:8080/disconnect
curl           http://localhost:8080/state
curl           http://localhost:8080/demos
```

See `doc/demo-replay.md` for the full endpoint and event reference, and
`doc/shot-trace.md` for the `shot` SSE event emitted for weapon traces.

## Tests

```bash
npm test          # run the Jest suite
npm run test:watch
```

See `doc/testing.md` for layout and conventions.

## Tools

### texture-export

List distinct renderable textures referenced by a BSP as `textures/<name>.wal`
paths (one per line on stdout). See `doc/texture-export.md` for details.

```bash
npx tsx src/texture-export.ts <file.bsp>
```

## Connection State Machine

```
DISCONNECTED → CONNECTING → CONNECTED → PREPARING → READY → STREAMING
                                                              ↕
                                                           SUSPENDED
```

| State | Description |
|---|---|
| `disconnected` | No connection |
| `connecting` | TCP connect in progress |
| `connected` | TCP connected, magic sent, waiting for echo |
| `preparing` | Hello sent, waiting for server hello |
| `ready` | Stream start requested, waiting for ack |
| `streaming` | Receiving MVD stream data |
| `suspended` | Server suspended stream (no active players) |

## Events

| Event | Payload | When |
|---|---|---|
| `connect` | — | Magic exchanged successfully |
| `hello` | `number` (flags) | Server hello received |
| `streamStart` | — | Stream start acknowledged |
| `streamStop` | — | Stream stop acknowledged |
| `streamData` | `Buffer` | MVD frame data received |
| `streamSuspend` | — | Empty stream data (no players) |
| `streamResume` | `Buffer` | Data after suspension |
| `pong` | — | Ping reply received |
| `error` | `{ code, message }` | Protocol or network error |
| `disconnect` | `{ reason }` | Server disconnect/reconnect |
| `close` | — | TCP socket closed |
| `stateChange` | `{ from, to }` | Any state transition |

## API

### `new MvdClient(options)`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | — | Server hostname/IP |
| `port` | `number` | — | Server port |
| `username` | `string` | `''` | GTV username |
| `password` | `string` | `''` | GTV password |
| `version` | `string` | `'ts-mvd/1.0'` | Client version string |
| `deflate` | `boolean` | `true` | Request zlib compression |
| `stringCmds` | `boolean` | `true` | Request command forwarding |
| `maxBuf` | `number` | `25` | Server-side buffer size hint |
| `pingInterval` | `number` | `60000` | Keepalive interval (ms) |
| `autoReconnect` | `boolean` | `false` | Auto-reconnect on drop |
| `reconnectDelay` | `number` | `5000` | Initial reconnect delay (ms) |
| `reconnectMaxDelay` | `number` | `300000` | Max reconnect delay (ms) |

### Methods

- **`connect()`** — Initiate TCP connection and handshake
- **`disconnect()`** — Close connection
- **`sendPing()`** — Send keepalive ping
- **`sendStringCmd(cmd)`** — Forward a command to the game server
- **`sendStreamStart()`** — Request stream start
- **`sendStreamStop()`** — Request stream stop

### Properties

- **`state`** — Current `ClientState`
- **`flags`** — Negotiated GTV flags after hello
