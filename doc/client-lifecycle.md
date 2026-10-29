# Client lifecycle hardening

Branch: `fix/client-lifecycle` (AUDIT-2 bugs 4 + 6, items 11 + 13)

## Problems

- **Pending auto-reconnect was invisible.** After a dropped live connection
  the client reported `state === disconnected` while a back-off timer was
  armed. `GET /state` said `idle` and `POST /replay` was accepted — the
  timer later fired into the same `MvdFrameParser` the replay was feeding.
- **Re-entrant `disconnect()` wedged the client.** A listener calling
  `disconnect()` inside `connect` or `hello` left the handshake running:
  `sendStreamStart()` + `setState(ready)` + `startPingTimer()` resurrected a
  dead client (`ready` state, no socket, leaked interval, `connect()`
  refused forever).
- **Outbound messages were uncapped.** `GTC` payloads above
  `MAX_GTC_MSGLEN` (256) were sent verbatim; a real GTV server drops the
  connection on them.
- **No session teardown.** `Session` owned socket, ping/reconnect timers,
  stats broadcast timer, replay reader and recorder fd with no single
  release path.

## Changes

### `MvdClient`

- **`reconnectPending` getter** — `true` while the auto-reconnect back-off
  timer is armed. `Session.mode` treats it as `live`, so `/state` and the
  exclusivity gates see the real picture.
- **Manual `connect()` cancels back-off** — clears the armed timer and
  resets the backoff counter before dialling. The timer callback clears
  itself first, so this only ever fires for external callers.
- **Re-entrancy guards** — after `emit('connect')`, `emit('hello')` and
  `emit('streamStop')` the handlers check `destroyed || !socket` and bail
  instead of continuing the handshake on a torn-down client.
- **`MAX_GTC_MSGLEN` enforcement** — `sendMessage` emits an `OVERSIZE`
  error and drops oversized payloads rather than writing them to the wire.
- **Timer hygiene** — `cleanup()` clears both the ping interval and the
  reconnect timeout in every teardown path (`disconnect()`, `softClose()`).

### `Session`

- **`startReplay()` disconnects the client first** — an armed reconnect
  timer cannot outlive the switch to replay.
- **`dispose()`** — releases every owned resource: stops replay, tears the
  client down (socket + ping/reconnect timers), removes client listeners,
  clears the stats broadcast timer, closes the recorder fd. The session is
  unusable afterwards; `resetAppStateForTests` deliberately keeps using the
  lighter `disconnect()` + `resetPipelineState()` path because sessions
  stay reusable across test cases.

## Tests

- `test/client.test.ts` — disconnect inside `hello`/`connect` listeners no
  longer wedges; `reconnectPending` visibility + manual-connect cancel;
  oversize outbound rejection.
- `test/app.test.ts` — `POST /replay` during back-off succeeds and clears
  the pending reconnect; `GET /state` reports `live` while armed.
- `test/session.test.ts` — `dispose()` on idle session and on active replay.
