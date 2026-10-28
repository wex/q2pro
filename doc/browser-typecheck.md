# Browser typecheck + shared consts

Branch: `feat/browser-typecheck`

## Scope

First step of migrating `public/app.js` to TypeScript (AUDIT suggestion 7):
typecheck-in-place instead of a rewrite — no bundler, no build step.

## What landed

- **`// @ts-check` + JSDoc** in `public/app.js`. DOM lookups are annotated
  with `@type` casts (`HTMLCanvasElement`, `HTMLInputElement`,
  `HTMLSelectElement`, `HTMLButtonElement`, `HTMLElement`); input `.value` /
  `.max` assignments use `String(...)`. `tsconfig.browser.json`
  (`allowJs`/`checkJs`/`noEmit`, `strict: false`, DOM+ES2020 libs, includes
  `public/consts.js` so its globals resolve in app.js). Run it with
  `npm run typecheck:browser`. `strict: false` is deliberate — the goal is
  real annotations now, stricter ratcheting later.
- **`public/consts.js`** — shared `CS_*` configstring layout constants,
  loaded in `index.html` before `app.js`. This removes the duplicated
  `CS_MODELS_*`/`CS_PLAYERSKINS_*`/`CS_MAXCLIENTS_*` block that previously
  drifted from `src/player-loadout.ts` (the class of bug behind AUDIT
  finding 1).
- **`test/browser-consts.test.ts`** — parity guard: parses `consts.js` and
  `src/player-loadout.ts` and asserts every `CS_*` value matches; also
  asserts `app.js` doesn't redeclare a `CS_*` const. No codegen ceremony —
  the Jest assertion is the single-source verification.

## Follow-ups (not in scope)

- `strict: true` on the browser project once typedefs for SSE payloads
  (`FrameEvent`, `KillEvent`, `ChatEvent`, `StatsSnapshot`) are written.
- Sharing richer structures (weapon-icon maps, MZ_* tables) once they have
  a TS-side source worth importing.
