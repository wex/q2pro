# Live `.mvd2` recording

Record an in-progress live GTV session to a `.mvd2` demo file under
`ts-mvd/assets/demos/`, making the recording instantly replayable via the
existing `POST /replay` route — no conversion step.

## Wire → file mapping

A `.mvd2` file is:

```
[4 bytes]  'MVD2' magic
repeated:
  [uint16 LE] length   (0 = EOF marker)
  [N bytes]   MVD command payload
```

The payload bytes are byte-identical to what the server sends inside a
`GTS_STREAM_DATA` message, so `Mvd2Writer` (`src/mvd2-writer.ts`) just frames
each incoming payload with its `uint16` length — no re-encode, no parsing.

Two edge rules:

- **Empty `streamData` payloads are skipped.** On the wire an empty payload is
  a stream *suspend* marker; in a `.mvd2` file a zero length is the EOF
  marker — writing it would truncate playback at the first suspend.
- `streamResume` payloads are recorded too; they carry a normal MVD message
  (the baseline the server resends after a suspend).

## API surface

- `Mvd2Writer` (exported from `src/index.ts`): `open(filePath)`,
  `writeMessage(payload)`, `close()`; counters `messages` / `bytesWritten`;
  `recording` / `file` accessors. `close()` appends the EOF marker and
  returns `{file, messages, bytes}` (or `null` when idle).
- `POST /record/start?name=foo` — `name` is sanitized to a basename and gets
  `.mvd2` appended if missing; defaults to `live-<ISO timestamp>.mvd2`.
  - `202 {file}` on success
  - `409 {error:'already-recording'}` / `409 {error:'not-streaming'}` when the
    client is not `Streaming`/`Suspended`
  - `400 {error:'invalid-name'}` on traversal attempts
- `POST /record/stop` — finalizes and returns `200 {file, messages, bytes}`;
  `404` when nothing is recording.
- `GET /state` gains `recording: {file, messages} | null`.
- SSE: `recordStart {file}` and `recordStop {file, messages, bytes[, reason]}`.
  On disconnect/close mid-recording the writer is finalized automatically and
  `recordStop` carries `reason: 'disconnect'`.

## Caveats

- A recording started mid-stream begins **without** the original serverdata /
  configstring baseline unless the server happens to resend it (e.g. after a
  suspend/resume cycle). Playback of such a file may show partial state until
  the next serverdata. Start recording right after connect for clean demos.
- Writes are synchronous (`fs.writeSync`) — ~10 messages/sec at a few KB each
  is negligible I/O, and it keeps close-time semantics trivial.

## Tests

`test/mvd2-writer.test.ts` covers the round-trip through `MvdDemoReader`,
the empty-payload skip, double-open/idle-close guards, and directory creation.
`app.test.ts` covers all four route outcomes and verifies a recorded file
replays verbatim.
