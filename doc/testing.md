# ts-mvd test suite

Jest + ts-jest unit/integration tests for `ts-mvd`. Source for the
`.mvd2` replay path uses the bundled `ts-mvd/assets/demos/demo.mvd2`
fixture so the suite never needs a live Q2Pro server.

## Running

From `ts-mvd/`:

```bash
npm install        # first time only
npm test           # full suite
npm run test:watch # watch mode
```

## Layout

```
ts-mvd/test/
  helpers/
    fixtures.ts      # DEMO_PATH, buildMvd2 synth helper
  buffer.test.ts     # BufferReader / BufferWriter roundtrips, varint
  demo.test.ts       # MvdDemoReader: magic, truncation, EOF, realtime pacing
  frame.test.ts      # MvdFrameParser driven by demo.mvd2; originToWorld; reset
  client.test.ts     # MvdClient state machine (mocked `net.Socket`)
  app.test.ts        # HTTP control surface via supertest
```

## Configuration

- `jest.config.ts` — ts-jest preset, `forceExit: true` (the `app` module
  keeps long-lived UDP/HTTP handles that can't all be torn down between
  suites without a deeper refactor).
- `tsconfig.test.json` — extends `tsconfig.json` adding `types: ["jest",
  "node"]` and widening `rootDir` so tests type-check alongside `src/`.
  The production build (`tsc`) still ships only `src/`.

## Testing conventions

- Pure modules (`buffer`, `demo`, `frame`) are fully isolated — no mocks.
- `client.test.ts` mocks the `net` module by returning a `FakeSocket` that
  extends `EventEmitter`, letting tests drive `connect`/`data`/`close`
  events synchronously.
- `app.test.ts` imports the `app` module (side-effect-light now that
  `httpServer.listen()` + `SIGINT` are gated behind `require.main ===
  module`) and calls `resetAppStateForTests()` between cases.
- Demo-driven tests use the synchronous drain path of `MvdDemoReader`
  (`realtime: false`) and wait one `setImmediate` tick before asserting.

## Adding tests

1. Put new `*.test.ts` files under `ts-mvd/test/`.
2. Reuse `fixtures.ts` helpers for demo bytes and synthetic `.mvd2`
   buffers. Avoid inlining binary literals where a helper exists.
3. If a new feature starts long-lived timers, either stop them in
   `afterEach`, use fake timers, or rely on `forceExit`.
4. Run `npm test` and `npm run build` before opening a PR.
