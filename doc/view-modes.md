# Watch modes + HUD layout

Branch: `feat/watch-modes`. Keyboard-driven panel visibility for spectating.

## Layout

- `#status` (connection/map/clock + replay controls) is centered horizontally
  at the top (`left: 50%; transform: translateX(-50%)`).
- `#panel-left` (kill feed + chat) starts at `top: 10px` — the centered bar
  no longer overlaps it.
- `#panel` (scoreboard + match stats) unchanged on the right.

## Modes

Hotkeys apply only when focus is not in an `INPUT`/`TEXTAREA`/`SELECT`
(typing in the connect form won't flip modes). `ESC` returns to the default
mode 0 from anywhere.

| Key | Mode | Hidden | Visible |
|-----|------|--------|---------|
| —   | 0    | (nothing) | everything (default) |
| `1` | 1    | status bar, chat, match stats | kill feed + scoreboard |
| `2` | 2    | status bar + all panels | map only |
| `3` | 3    | status bar, left panel, match stats | scoreboard only |
| `7` | 7    | status bar, left panel, match stats | scoreboard only (same as 3) |
| `8` | 8    | status bar, left panel, scoreboard | match stats only |
| `9` | 9    | status bar, right panel, chat | kill feed only |

Modes 3 and 7 produce the same visible set; both hotkeys are bound per spec.

## Implementation

`app.js` keeps `viewMode` state and mirrors it onto
`document.body[data-viewmode]` (absent = default 0). All visibility rules are
pure CSS `body[data-viewmode="N"] … { display: none }` selectors in
`app.css`, so panels keep receiving SSE updates while hidden and reappear
instantly on ESC. `setViewMode(0)` is the only reset; modes persist across
session/replay switches until ESC.

Follow mode (`#panel-left.follow-mode`) composes independently — camera-lock
still hides the feed column in any watch mode.
