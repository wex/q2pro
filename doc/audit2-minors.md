# AUDIT-2 minor-item sweep

Branch: `fix/audit2-minors` (AUDIT-2 item 16 + leftovers)

## What changed

- **`FrameEvent.players[i].stats` / `StatsEvent.stats` are now copies.**
  Both previously emitted the parser's live `Int16Array` — a consumer
  retaining a frame or stats event would see later mutations instead of
  the snapshot (`stats.slice()` in the active-player builder and in
  `onStats`).
- **Delegated icon fallback in `public/app.js`.** `loadoutIconHtml` used
  to embed an inline `onerror` handler containing an HTML-escaped label
  inside a JS string literal — safe only because labels come from a fixed
  table. The markup is now a plain `<img>`; a single capture-phase
  `error` listener on `document` (error events don't bubble) swaps any
  broken `img.sb-icon` for its label text.
- **`tsx` moved to `devDependencies`.** It's a dev convenience
  (`npx tsx src/app.ts`); the library needs no runtime deps.
- **`closeAppForTests()` releases all module handles.** Sessions
  (`Session.dispose()`), the SSE heartbeat interval, the UDP status
  socket and the HTTP listener are all closed, so `jest.config.ts` no
  longer sets `forceExit` — the suite exits on its own.
- **Status reply attribution** was already hardened in
  `fix/control-surface-hardening` (DNS-resolved address set) — see
  `doc/app-hardening.md`.

## Docs touched

`AGENTS.md`, `doc/testing.md`, `doc/how-to-use-devin.md` — `forceExit`
references replaced with the `closeAppForTests()` convention.
