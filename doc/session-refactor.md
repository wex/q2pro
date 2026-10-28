# Session refactor

Branch: `feat/session-refactor`

## Scope

Groundwork for multi-stream support (AUDIT suggestion 5): the singleton
pipeline that used to live directly in `app.ts` now lives in `src/session.ts`
as a `Session` class. Shared resources — the SSE client set, UDP socket,
pak index, BSP cache, HTTP routes — stay in `app.ts`.

## What moved into `Session`

- `MvdClient`, `MvdFrameParser`, `Mvd2Writer`, `CombatFxResolver`,
  `StatsTracker` (one each per session).
- Derived state: `configstrings`, `players`, `csExtended`, `chatLog`,
  `killFeed`, `scoreboard`, `latestStatus`, `host`/`port`.
- Replay lifecycle: `currentReplay`, `startReplay`, `stopReplay`,
  `replayStatePayload`, `broadcastReplayState`.
- `attachPipeline()` — wires every `parser.on*`/`client.on` callback exactly
  once at construction. This replaces the `origOnFrame`/`origOnFrame2`
  wrapper chain that accreted in `app.ts`.
- `snapshot()` — the `/events` snapshot payload.
- `mode` — `'replay' | 'live' | 'idle'`.

## Boundary

```ts
new Session(id, {
    host, port,
    broadcast: sseBroadcast,        // outbound event sink
    statusQuery: sendOOBStatus,     // shared UDP socket
    clientOpts: { username, password, autoReconnect, ... },
});
```

`app.ts` keeps a `sessions` map (`'default'` today). Every mutating route
accepts `?session=<id>` → `404 {error:'unknown-session'}` for unknown ids.
Exclusivity (one live *or* one replay) remains a route-level policy, not a
Session invariant — that leaves room for real multi-stream sessions later.

SSE payloads now carry a `session` field (e.g. `frame`, `stats`, `sound`,
`serverdata`, snapshot). `public/app.js` ignores unknown fields, so no UI
change was needed.

## Back-compat surface

`app.ts` still exports `client`, `parser`, `startReplay`, `stopReplay`,
`getScoreboardForTests`, `getPlayersForTests` — now aliased to the default
session, so existing tests and embedders keep working unchanged.
