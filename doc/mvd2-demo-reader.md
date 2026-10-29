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
| `realtime` | `boolean` | `false` | Emit one server frame per tick (mimics live stream) |
| `tickMs` | `number` | `100` | Tick interval when `realtime` is true (10 Hz) |

### Methods

- **`play(path)`** — read the file synchronously, then emit messages.
- **`playBuffer(buf)`** — same, but from an in-memory buffer (useful for tests
  or pre-inflated `.mvd2.gz` payloads).
- **`stop()`** — cancel pacing and drop queued messages.
- **`pause()` / `resume()`** — gate the realtime timer without losing position.
- **`seek(targetIndex)`** — snap to the nearest keyframe ≤ target, silently
  re-emit `[keyframe, target)` as catch-up, then resume realtime there.
- **`setSpeed(m)`** — scale the tick interval, clamped to [0.25, 8].

See `doc/demo-controls.md` for the full playback-controls reference.

### Events

| Event | Payload | When |
|---|---|---|
| `message` | `Buffer`, `catchup: boolean` | One `.mvd2` record (feed into `MvdFrameParser.parse`). `catchup` is true for seek-time silent rebuilds — parse but suppress outward broadcasts. |
| `end` | — | EOF marker reached or all messages emitted |
| `error` | `Error` | File missing, bad magic, truncated record |
| `seek` | snapped index | `seek()` resolved to a keyframe — reset parser state |
| `seeked` | target index | Silent catch-up finished; realtime resumes from here |
| `pause` / `resume` | — | Playback gated / ungated |

## Pacing notes

Real `.mvd2` files interleave configstrings, multicasts and frames without
timestamps. In `realtime` mode each tick bursts every message up to and
including the next one whose first op is `mvd_frame` — one *server frame*
per tick, so frame-less runs and multi-frame messages keep live pacing.
Use default non-realtime mode for synchronous test runs.

## Out of scope

- No gzip / `.mvd2.gz` decoding (call `zlib.gunzipSync` yourself and hand the
  result to `playBuffer`).
- No looping — playback ends at EOF (seeking backward after `end` works).
