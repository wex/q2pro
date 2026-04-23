# How to use Devin with this repo

This guide is the onboarding + day-to-day workflow for delegating `ts-mvd`
tasks to [Devin](https://devin.ai). It assumes you have read `AGENTS.md`
at the repo root — Devin should treat that file as its primary rulebook.

## 1. What Devin is for here

- Active development happens in `ts-mvd/` (TypeScript MVD/GTV client).
- `src/` (Q2Pro C server) and `inc/` (C headers) are **read-only
  reference**. Devin must never modify them.
- Typical Devin tasks: add a feature to `ts-mvd/`, extend the parser,
  harden the state machine, grow the test suite, or author a doc in
  `doc/`.

## 2. One-time setup

1. **Install the Devin GitHub App** on the `q2pro` repository and grant
   it the access it needs to read code, open branches, and file pull
   requests. Follow Devin's own install flow — don't duplicate their
   instructions here.
2. **Point Devin at `AGENTS.md`.** It already encodes the repo layout,
   `ts-mvd` module map, build/test commands, dependency list, testing
   conventions, and the hard rules. Linking it in the first message of
   every session is usually enough.
3. **Secrets / env.** None are required for the default workflow:
   - The test suite drives replays from the bundled
     `ts-mvd/assets/demos/demo.mvd2` fixture.
   - A reachable Q2Pro GTV server is **only** needed for manual
     `npm run app` smoke tests. Don't hand Devin live server
     credentials unless a task explicitly needs them.

## 3. Machine bootstrap (per Devin session)

Give Devin this snippet as the environment bootstrap for the sandbox:

```bash
# From the repo root
node --version   # must be >= 20

cd ts-mvd
npm install

# Verify the environment
npm test
npm run build
```

Both `npm test` and `npm run build` must pass before Devin starts
editing. Treat a red baseline as a blocker and fix the environment
first.

## 4. Assigning a task

Use a prompt template along these lines:

```
Goal: <one-sentence outcome>
Acceptance criteria:
  - <testable check 1>
  - <testable check 2>
Scope: ts-mvd/ only. Do not touch src/ or inc/.
Touched modules (expected): <from the ts-mvd module map in AGENTS.md>
Deliverables:
  - Code under ts-mvd/src/
  - Tests under ts-mvd/test/ (Jest + ts-jest)
  - New or updated doc at doc/<feature>.md
  - README/API note if ts-mvd/src/index.ts surface changes
Branch: one feature per branch, name summarizes the feature.
Checks: npm test and npm run build (from ts-mvd/) must be green.
```

Hard rules to restate when a task is risky:

- Never edit files under `src/` or `inc/`.
- Keep the public API in `ts-mvd/src/index.ts` stable unless the task is
  explicitly an API change.
- TypeScript strict, 2-space indent, named exports where existing code
  uses them.

## 5. Expected deliverables per PR

Every Devin PR should include:

- Code changes confined to `ts-mvd/` (primarily `ts-mvd/src/`).
- New or updated tests in `ts-mvd/test/` matching `*.test.ts`, reusing
  `ts-mvd/test/helpers/fixtures.ts` where possible.
- A feature doc at `doc/<feature>.md` covering scope, protocol
  touchpoints, and usage (per `AGENTS.md` "Workflow conventions").
- A `ts-mvd/README.md` update if the public API surface changes.
- Green `npm test` and `npm run build` runs, shown in the PR
  description or CI log.

## 6. Review checklist for humans

Before merging a Devin PR, verify:

- [ ] Branch name summarizes the feature (one feature per branch).
- [ ] No files changed under `src/` or `inc/`.
- [ ] `doc/<feature>.md` exists and is accurate.
- [ ] Tests were added or updated; `npm test` is green locally.
- [ ] `npm run build` is green locally.
- [ ] `AGENTS.md` still matches reality (module map, scripts, deps). If
      Devin changed any of those, `AGENTS.md` should be updated in the
      same PR.
- [ ] Public API (`ts-mvd/src/index.ts`) changes are intentional and
      documented in `ts-mvd/README.md`.

## 7. Troubleshooting tips to hand Devin

- The `app` module owns long-lived HTTP/UDP handles; `jest.config.ts`
  sets `forceExit: true` for that reason. Don't weaken `forceExit`
  without a deeper refactor.
- `app.test.ts` must keep `httpServer.listen()` and `SIGINT` hooks
  behind `require.main === module`, and call `resetAppStateForTests()`
  between cases.
- Demo-driven tests use `MvdDemoReader` with `realtime: false` and wait
  one `setImmediate` tick before asserting — see `doc/testing.md`.
- `client.test.ts` mocks `net` via a `FakeSocket` extending
  `EventEmitter`; don't introduce real sockets in unit tests.
- If a task genuinely needs a live Q2Pro GTV server, flag it in the
  prompt and expect Devin to stub or mock rather than invent
  credentials.

## 8. Pointers

- `AGENTS.md` — primary rulebook (repo layout, module map, rules).
- `doc/testing.md` — Jest/ts-jest layout and conventions.
- `doc/mvd-system.md` — MVD subsystem deep dive.
- `doc/network.md` — wire protocol reference.
- `ts-mvd/README.md` — user-facing API and events.
