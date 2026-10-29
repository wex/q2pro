# Per-round team scores

Branch: `feat/round-scores`. Implements the remainder of AUDIT-2 feature
suggestion 3 (round detection from AQ2's own signals — start markers landed
in `fix/centerprint-round-dedup`; this adds end markers + score capture).

## Scope

Each `RoundStats` now carries `teamScores` (`{team1, team2, team3}` — the
`STAT_TEAM{1,2,3}_SCORE` tally at the round's close) and `endedAt`; the
snapshot derives `winner` (`'team1'|'team2'|'team3'|'tie'|undefined`).

## Signals

- `Stat.Team{1,2,3}Score` (player-state stats, AQ2 indices 26/27/31) were
  already decoded into `FrameEvent.teamScores`; `Session.onFrame` now also
  feeds `stats.noteScores(ev.teamScores)` so the tracker keeps a live tally.
- Round END: AQ2's `WonGame` broadcasts `"The round is over:"` at PRINT_HIGH
  (`src/action/a_team.c:2772`) — a broadcast `mvd_print` → `onPrint` →
  `noteText`. `StatsTrackerOptions.endPatterns` (default
  `DEFAULT_END_PATTERNS = [/^the round is over/i]`) closes the current round
  **without opening a new one** — unlike `roundPatterns`, which open.
- A round closed implicitly (next start marker, no end print) still gets
  stamped with the latest seen tally on `newRound()`. The live round shows
  the current tally at snapshot time.
- The `STAT_TEAM*_SCORE` delta lands a frame or two *after* the end print
  (the score++ happens inside `WonGame` after the bprintf). An
  ended-but-unstamped round keeps absorbing `noteScores` updates until the
  next round opens, so the close-time ordering doesn't lose the result.
- All-zero tallies are never stamped — DM streams and pre-score segments
  keep `teamScores` absent, not `{0,0,0}` noise.
- Stat slot 31 is overloaded in AQ2: `SetCTFStats` (`a_ctf.c:1150`) writes
  `STAT_TEAM2_HEADER` — a configstring *image* index — while teamplay /
  domination write `STAT_TEAM3_SCORE` only when `teamCount == 3`
  (`a_team.c:3261`). `applyStat` treats the slot as a score only when
  `|value|` is below the layout's `images` configstring base (544 vanilla /
  10302 EXTLIMITS); pic indices always land at/above it, real scores stay
  far below. Without this gate CTF streams show a phantom `T3: <pic idx>`.

## Snapshot shape

```ts
rounds: [{
  index, startedAt, endedAt?,
  teamScores?: { team1, team2, team3 },
  winner?: 'team1' | 'team2' | 'team3' | 'tie',
  players, weaponKills,
}]
```

`winner` is strict argmax; equal non-zero top scores → `'tie'`; absent when
no team scores were ever seen.

## UI

~~`#stats-section` gains a `#round-scores` strip: one chip per scored round
(`R{index}: T1 a–b T2`, `T3` appended when non-zero), the winning team's
chip highlighted.~~ Removed from the browser panel — `teamScores`/`winner`
remain on the snapshot rounds for API consumers.

## Verification

`test/stats.test.ts`: end-marker stamping (no phantom round), implicit close
on next start marker, winner win/tie/all-zero, `endPatterns` override,
`noteText` still boolean. `test/session.test.ts` — `onFrame` → `noteScores`
wiring end-to-end. Empirical: replaying `demo.mvd2` stamps the
`ACTION!`-opened round `{t1:0, t2:1, t3:0}` → `winner: 'team2'`.
