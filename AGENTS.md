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
- `example.ts` — runnable usage example.
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
- `npm run example` — run `src/example.ts` via `ts-node`.

Requires Node.js 20+ (matches `@types/node` ^20).

## Dependencies
- Dev: `typescript` ^5.4, `ts-node` ^10.9, `@types/node` ^20.
- Runtime: `tsx` ^4.21.
- Prefer versions already in `ts-mvd/package.json`; avoid adding dependencies without a clear reason.

## Testing & verification
- No test framework is currently configured.
- For any change, verify with `npm run build` (must pass `tsc`) and, where feasible, `npm run example` against a reachable Q2Pro GTV server.
- When introducing tests, propose a framework choice before installing.

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