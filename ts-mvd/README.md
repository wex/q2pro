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
    autoReconnect: true,  // reconnect on drop / recoverable protocol errors
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

## Run the control surface

```bash
npm run app
# or: npx tsx src/app.ts [host] [port]
```

Opens the HTTP UI on port 8080. Use the **Connect to server** form (host, port,
password) or `POST /connect` with JSON `{ host?, port?, password? }`.

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
     -d '{"host":"example.com","port":27910,"password":"secret"}' \
     http://localhost:8080/connect                     # live GTV with explicit target
curl -X POST   http://localhost:8080/disconnect
curl           http://localhost:8080/state
curl           http://localhost:8080/demos
curl           http://localhost:8080/paks
curl -X POST   'http://localhost:8080/record/start?name=match1'  # → assets/demos/match1.mvd2
curl -X POST   http://localhost:8080/record/stop
curl           http://localhost:8080/stats     # per-round K/D / hit locations / weapons
```

See `doc/demo-replay.md` for the full endpoint and event reference,
`doc/session-stats.md` for the `stats` SSE event and round detection,
`doc/aq2-obituaries.md` for kill-feed attribution (`ObituaryEvent.kind` /
`mod` / `location`), `doc/combat-fx.md` for the `flash` / `damage` SSE
events used by the map overlay FX, and `doc/player-loadout.md` for
scoreboard HP / weapon / ammo enrichment (stream roster vs sticky
loadout).

## Pak / Pkz asset fallback

Drop original Quake 2 `.pak` archives or Q2Pro `.pkz` (zip) archives into
`ts-mvd/paks/`. At startup `app.ts` indexes every archive and uses it as a
fallback for missing maps and wal textures: `GET /maps/<name>` will resolve
`<name>.bsp` from `maps/` first, then from any indexed archive, and the SVG
renderer pulls wal textures and `colormap.pcx` the same way. The currently
loaded archives are exposed via `GET /paks`. See `doc/pak-vfs.md` for the
full design and format notes.

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
| `error` | `{ code, message }` | Protocol or network error. Emitted only when a listener is attached — unhandled errors are dropped rather than thrown, so attach a listener if you need them (lifecycle still surfaces via `disconnect`/`close`). |
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
| `stringCmds` | `boolean` | `true` | Request command forwarding |
| `deflate` | `boolean` | `true` | Request zlib stream compression (`GTF_DEFLATE`) |
| `maxBuf` | `number` | `25` | Server-side buffer size hint |
| `pingInterval` | `number` | `60000` | Keepalive interval (ms) |
| `autoReconnect` | `boolean` | `false` | Auto-reconnect on drop / recoverable errors |
| `reconnectDelay` | `number` | `5000` | Initial reconnect delay (ms) |
| `reconnectMaxDelay` | `number` | `300000` | Max reconnect delay (ms) |

When the server grants `GTF_DEFLATE`, all inbound bytes after `GTS_HELLO`
(length headers included) inflate through zlib — transparent to consumers;
check `client.flags & GTF_DEFLATE` for the negotiated state.

### Methods

- **`connect()`** — Initiate TCP connection and handshake. Calling it during
  auto-reconnect back-off cancels the pending timer and dials immediately.
- **`disconnect()`** — Close connection (emits `close`; no auto-reconnect).
  Safe to call from inside any event listener — internal handlers bail out
  rather than resurrecting state on a dead socket.
- **`setTarget(host, port, password?)`** — Update GTV target while disconnected
- **`sendPing()`** — Send keepalive ping
- **`sendStringCmd(cmd)`** — Forward a command to the game server
- **`sendStreamStart()`** — Request stream start
- **`sendStreamStop()`** — Request stream stop

Outbound GTV messages are capped at `MAX_GTC_MSGLEN` (256 bytes incl. opcode) —
larger sends emit an `OVERSIZE` error and are dropped instead of provoking a
server-side disconnect.

### Properties

- **`state`** — Current `ClientState`
- **`flags`** — Negotiated GTV flags after hello
- **`reconnectPending`** — `true` while an auto-reconnect back-off timer is
  armed (`state` reports `disconnected` but a reconnect is scheduled). Treat
  as "live" for live/replay exclusivity checks; `Session.mode` does this.
