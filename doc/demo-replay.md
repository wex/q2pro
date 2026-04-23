# Demo replay over SSE

The `ts-mvd` app server can replay a Q2Pro `.mvd2` demo through the same
`MvdFrameParser` + SSE broadcast pipeline used for live GTV, so browser
clients under `ts-mvd/public/` see identical `serverdata`, `configstring`,
`frame`, `chat`, `kill`, `hit`, `layout`, and `te` events.

## Scope

- Replay is file-driven via `MvdDemoReader` (see `ts-mvd/src/demo.ts`).
- File format: the Q2Pro `MVD2`-framed stream described in
  `doc/mvd-system.md` §3.1.
- Pacing: realtime at 10 Hz (`tickMs: 100`), non-looping. Playback stops on
  end-of-file and broadcasts `replayEnd`.
- The server starts in **idle** mode. Neither live GTV nor replay begins
  automatically; both are opt-in via HTTP endpoints.
- Replay and live GTV are mutually exclusive. OOB UDP status polling is
  suppressed while a replay is active.

## Endpoints

| Method | Path                    | Purpose                                         |
|--------|-------------------------|-------------------------------------------------|
| GET    | `/state`                | `{ mode, clientState, replayFile }`             |
| POST   | `/connect`              | Start live GTV (rejected if replay active)      |
| POST   | `/disconnect`           | Stop live GTV                                   |
| POST   | `/replay[?file=<path>]` | Start demo replay; default `assets/demos/demo.mvd2`. Path is resolved relative to `ts-mvd/` |
| DELETE | `/replay`               | Stop active replay                              |

`POST /replay` responds:
- `202 { file }` — replay accepted and started.
- `404 { error: 'not-found', file }` — path does not exist.
- `409 { error: 'replay-active' \| 'live-active', … }` — another mode is busy.

## SSE events added

In addition to the existing stream events:
- `replayStart` — `{ file }` when replay begins.
- `replayEnd` — `{}` when replay finishes or is cancelled.
- `replayError` — `{ message }` on demo-reader errors.

## Usage

```bash
# idle server
npm run app

# in another shell:
curl -X POST http://localhost:8080/replay
# … open http://localhost:8080/ to watch …
curl -X DELETE http://localhost:8080/replay

# later, go live:
curl -X POST http://localhost:8080/connect
```

## Implementation notes

- `MvdDemoReader` emits framed payload `Buffer`s shaped exactly like the
  `streamData` event from `MvdClient`, so the existing `parser.parse(buf)`
  wiring is reused verbatim.
- Transient state (`configstrings`, `players`, `chatLog`, `killFeed`,
  `scoreboard`, `latestStatus`) is flushed by `resetPipelineState()` when a
  replay starts so stale live data is not mixed in.
- Parse errors during replay call `parser.reset()` and log, matching the
  live `streamData` behaviour.
