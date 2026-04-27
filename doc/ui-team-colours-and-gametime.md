# Team-coloured scoreboard and elapsed gametime

Adds visual cues that mirror the map markers: scoreboard names are tinted by the team `getTeamMap()` already infers from playerskins, and the top status bar shows an elapsed `MM:SS` counter derived from the live frame number.

## Scoreboard team colours

- `renderScoreboard` (`@/home/wex/q2pro/ts-mvd/public/app.js`) wraps each name in `<span class="player-name team-N">` where `N` is the team index from `getTeamMap()`.
- Only applied when ≥ 2 distinct teams are detected and at least two players share a team — otherwise we treat the round as FFA and render names plain (white). This avoids confetti-colouring duels and skin-distinct DM rounds.
- CSS (`@/home/wex/q2pro/ts-mvd/public/app.css`):
  - `.player-name.team-0` red, `.team-1` blue, `.team-2` green, matching `TEAM_COLOURS[*].stroke` used for player markers on the map.
  - `.player-name` is bold for legibility.

## Elapsed gametime

- New `<span id="status-time">` in `@/home/wex/q2pro/ts-mvd/public/index.html` between the map name and the player count.
- `formatGametime(frameNumber)` divides by 10 (Q2Pro server tick is 100 ms) and renders `MM:SS` (or `H:MM:SS` once the level passes one hour).
- `updateGametime` is called on every SSE `frame` event and reset to `00:00` on `serverdata` (map change). Demos and live streams behave identically since both deliver `frameNumber` per frame.
- Style: tabular numerics so the counter doesn't jitter.

## Verification

This is purely a UI change. Server-side Jest suite (59 tests) is unaffected. Manual smoke check:

1. `cd ts-mvd && npm run app`
2. Replay `assets/demos/demo.mvd2` or attach to a live GTV server.
3. Confirm:
   - The status bar shows `MM:SS` ticking once per second.
   - On map restart the counter resets.
   - In a CTF/team match, scoreboard names match the colours of the player markers; in FFA they stay white.
