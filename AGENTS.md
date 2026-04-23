# ts-mvd player

## Overview
This is a TypeScript MVD/GTV client for Q2Pro servers. The C server sources under `src/` and headers under `inc/` are reference-only; all active development happens in `ts-mvd/`.

## Repository layout
- `ts-mvd/` — main TypeScript project (edit here).
- `src/` — Q2Pro C server source (read-only reference).
- `inc/` — Q2Pro C headers (read-only reference).
- `doc/` — design docs: `network.md`, `mvd-system.md`, and future feature docs.
- `ts-client/` — sibling TS project; out of scope for ts-mvd tasks.

## ts-mvd module map
Source lives in `ts-mvd/src/`:
- `client.ts` — GTV TCP client, connection state machine, event emitter.
- `protocol.ts` — opcodes, flags, constants (`MvdOp`, `SVCMD_MASK`, GTV hello/flags).
- `frame.ts` — MVD frame/message parsing.
- `buffer.ts` — bit/byte reader helpers.
- `bsp.ts` — BSP map loader.
- `wal.ts` — WAL texture loader.
- `map-render.ts` — map visualization.
- `demo.ts` — `MvdDemoReader` for `.mvd2` replay files.
- `texture-export.ts` — texture asset export helper.
- `app.ts` — HTTP/UDP control surface wiring demo + client pipelines.
- `index.ts` — public exports.
- `ts-mvd/public/` — static assets for the browser demo (`index.html`, `app.js`, `app.css`).

## Protocol / state machine
```
DISCONNECTED → CONNECTING → CONNECTED → PREPARING → READY → STREAMING
                                                              ↕
                                                          SUSPENDED
```
See `doc/mvd-system.md` and `doc/network.md` for deep dives, and `ts-mvd/README.md` for the event/API surface.

## Build & run
Run from `ts-mvd/`:
- `npm install` — install dependencies.
- `npm run build` — `tsc` compile to `dist/`.
- `npm run app` — run `src/app.ts` via `ts-node` (HTTP/UDP control surface).
- `npm test` — run the Jest suite.
- `npm run test:watch` — Jest in watch mode.

Requires Node.js 20+ (matches `@types/node` ^20).

## Dependencies
- Dev: `typescript` ^5.4, `ts-node` ^10.9, `@types/node` ^20, `jest` ^29, `ts-jest` ^29, `@types/jest` ^29, `supertest` ^7, `@types/supertest` ^7.
- Runtime: `tsx` ^4.21.
- Prefer versions already in `ts-mvd/package.json`; avoid adding dependencies without a clear reason.

## Testing & verification
The test runner is Jest with `ts-jest`. See `doc/testing.md` for the full guide.

- Suites live in `ts-mvd/test/` matching `*.test.ts`: `buffer.test.ts`, `demo.test.ts`, `frame.test.ts`, `client.test.ts`, `app.test.ts`.
- Shared fixtures in `ts-mvd/test/helpers/fixtures.ts` (exports `DEMO_PATH` and a `buildMvd2` synth helper). Replay tests use the bundled `ts-mvd/assets/demos/demo.mvd2` so no live Q2Pro server is needed.
- Configs:
  - `ts-mvd/jest.config.ts` — `ts-jest` preset, `testEnvironment: node`, `forceExit: true` (the `app` module owns long-lived UDP/HTTP handles).
  - `ts-mvd/tsconfig.test.json` — extends `tsconfig.json`, adds `jest`/`node` types and widens `rootDir` so tests type-check alongside `src/`. The shipped `tsc` build still emits only from `src/`.
- Conventions:
  - Pure modules (`buffer`, `demo`, `frame`) are tested without mocks.
  - `client.test.ts` mocks `net` with a `FakeSocket` extending `EventEmitter` to drive `connect`/`data`/`close` synchronously.
  - `app.test.ts` uses `supertest` against the exported Express app and calls `resetAppStateForTests()` between cases; `httpServer.listen()` and `SIGINT` hooks are gated behind `require.main === module`.
  - Demo-driven tests use `MvdDemoReader` with `realtime: false` and wait one `setImmediate` tick before asserting.
- Adding tests: drop new `*.test.ts` files under `ts-mvd/test/`, reuse `fixtures.ts` helpers, and stop any long-lived timers in `afterEach` (or rely on `forceExit`).
- Before opening a PR, run both `npm test` and `npm run build` from `ts-mvd/`. Where feasible, also smoke-test `npm run app` against a reachable Q2Pro GTV server.

## Workflow conventions
- One feature per Git branch; branch name summarizes the feature.
- Every new feature: add or extend a doc in `doc/` (e.g. `doc/<feature>.md`) covering scope, protocol touchpoints, and usage.
- Follow existing code style (2-space indent, TS strict, named exports where present).
- Keep the public API in `ts-mvd/src/index.ts` stable; document additions in `ts-mvd/README.md`.

## Rules
- Always use TypeScript for the main project
- Never modify files under `src/` directory
- Never modify files under `inc/` directory
- Every new feature should be documented in `doc/` directory and summarized as own feature branch in Git.
- Always follow the existing code style and patterns.

## Reference docs
- `ts-mvd/README.md` — user-facing API and events.
- `doc/mvd-system.md` — MVD subsystem.
- `doc/network.md` — wire protocol.
- `doc/testing.md` — test suite layout, configs, and conventions.
- `doc/demo-replay.md` — demo replay pipeline.
- `doc/mvd2-demo-reader.md` — `.mvd2` reader details.
- `doc/texture-export.md` — texture export tooling.
- `doc/how-to-use-devin.md` — onboarding + workflow for Devin.