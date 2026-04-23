# .mvd2 Demo Reader

`MvdDemoReader` streams a local Q2Pro `.mvd2` demo file into `MvdFrameParser`,
producing the same event surface as a live GTV connection — useful for
deterministic parser tests and offline analysis.

Source: `ts-mvd/src/demo.ts`.

## File format

See `doc/mvd-system.md` §3.1. Summary:

```
[4 bytes]  'MVD2' magic (0x4D564432)
repeated:
  [uint16 LE] message length   (0 = EOF marker)
  [N bytes]   MVD command payload
```

Each payload is the exact byte sequence a live GTV `streamData` event delivers,
so `MvdFrameParser.parse(buffer)` consumes it unchanged.

## API

```ts
import { MvdDemoReader, MvdFrameParser } from 'ts-mvd';

const parser = new MvdFrameParser();
parser.onServerData = (ev) => console.log('serverdata', ev.gamedir);
parser.onFrame       = (ev) => console.log('frame', ev.frameNumber, ev.players.length);

const reader = new MvdDemoReader({ realtime: true }); // 10 Hz pacing
reader.on('message', (buf) => parser.parse(buf));
reader.on('end',     () => console.log('demo done'));
reader.on('error',   (err) => console.error(err));
reader.play('assets/demos/demo.mvd2');
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `realtime` | `boolean` | `false` | Emit one message per tick (mimics live stream) |
| `tickMs` | `number` | `100` | Tick interval when `realtime` is true (10 Hz) |

### Methods

- **`play(path)`** — read the file synchronously, then emit messages.
- **`playBuffer(buf)`** — same, but from an in-memory buffer (useful for tests
  or pre-inflated `.mvd2.gz` payloads).
- **`stop()`** — cancel pacing and drop queued messages.

### Events

| Event | Payload | When |
|---|---|---|
| `message` | `Buffer` | One `.mvd2` record (feed into `MvdFrameParser.parse`) |
| `end` | — | EOF marker reached or all messages emitted |
| `error` | `Error` | File missing, bad magic, truncated record |

## Pacing notes

Real `.mvd2` files interleave configstrings, multicasts and frames without
timestamps. In `realtime` mode this reader emits one **message** per tick
rather than one **frame** — simple and sufficient for test-material playback.
Use default non-realtime mode for synchronous test runs.

## Out of scope

- No gzip / `.mvd2.gz` decoding (call `zlib.gunzipSync` yourself and hand the
  result to `playBuffer`).
- No seeking, pausing, or looping — linear playback only.
