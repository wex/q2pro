# Session stats

Branch: `feat/session-stats`

## Scope

Aggregate per-round match statistics server-side from the event stream the
parser already produces — no protocol changes. Exposed over HTTP
(`GET /stats`), SSE (`stats`), and a "Match stats" panel in the browser UI.

## Event sources

| Signal | Feeds |
|---|---|
| `onObituary` | kills + weapon attribution (AQ2 `ClientObituary` table — see `doc/aq2-obituaries.md`; `kind:'info'` lines are ignored) |
| `onDeath` | deaths — the `STAT_HEALTH` → 0 edge is authoritative |
| `onHit` | hits dealt + body-location tally (`head`/`chest`/`stomach`/`legs`/`body`) |
| `onHitTaken` | hits received |
| `onTempEntity` (`TE_DAMAGE_DEALT`) | damage dealt — the AQ2 hit-marker number (`doc/damage-stats.md`) |
| `onLayout` / `onCenterPrint` / broadcast `onPrint` text | round-boundary detection (start + end markers — `doc/round-scores.md`) |
| `onFrame.teamScores` | per-round team score capture (`doc/round-scores.md`) |

`StatsTracker` lives in `src/stats.ts` — pure module, injectable clock and
`namer` callback for testing.

## Caveats (deliberate design limits)

- **Round detection is heuristic.** There is no MVD-level round marker; AQ2
  TNG signals round start via `CenterPrintAll("LIGHTS…/CAMERA…/ACTION!")`
  (`src/action/a_team.c`) and match end via broadcast prints
  (`Timelimit hit.`, `Fraglimit hit.`, `Match ended.` — the same strings
  `MVD_ParsePrint` special-cases). `DEFAULT_ROUND_PATTERNS` covers
  `FIGHT!`, `ACTION!`, `Round N`, `round begins`, `match start`,
  `^(timelimit|fraglimit) hit`, `match ended` — narrow on purpose: a false
  positive only splits a round, never corrupts data. The match-end prints
  are fed from **broadcast** `mvd_print` ops only (`clientNum ===
  undefined`); unicast prints are per-recipient and excluded. Round-end
  prints (`"The round is over:"` via `DEFAULT_END_PATTERNS`) close the
  current round and stamp its final `teamScores`/`endedAt` without opening
  a new one — see `doc/round-scores.md`. Streams
  without boundary text accumulate into a single round. Override via
  `StatsTrackerOptions.roundPatterns` / `endPatterns`.
- **Centerprints dedupe per tick.** `PF_centerprintf` is a unicast, so
  `CenterPrintAll` arrives once per connected client; the parser collapses
  same-text duplicates within a tick (same mechanism as chat/obituaries —
  see `doc/chat-dedup.md`), so one `ACTION!` opens exactly one round.
- **Name resolution lags the roster.** Names resolve through the playerskin
  configstrings (`"name\skin"` at `csLayout().playerskins + num`) *at event
  time* — events fired before configstrings populate land under the numeric
  `clientNum` string and are not retroactively merged.
- **Kills and deaths can diverge** when `sv_mvd_nostats`/`sv_mvd_nomsgs`
  strips prints: `onDeath` is a stats edge (always present), obituaries are
  print-derived (filtered by nomsgs). Weapon attribution additionally needs
  the kill-feed prints.
- **`hits` counts hits that landed**, not shots fired — there is no reliable
  per-shot signal in MVD (muzzleflash covers primary fire only).
- **`damageDealt` is attacker-side exact** — the same number AQ2 shows as a
  hit marker (`TE_DAMAGE_DEALT` unicast); it credits damage dealt but names
  no victim, and old protocols never emit it (see `doc/damage-stats.md`).

## API

```ts
const stats = new StatsTracker({ namer: playerNameFor });
parser.onObituary = (ev) => stats.noteObituary(ev);
parser.onDeath    = (ev) => stats.noteDeath(ev);
parser.onHit      = (ev) => stats.noteHit(ev);
parser.onHitTaken = (ev) => stats.noteHitTaken(ev);
parser.onTempEntity = (ev) => {
    if (ev.type === TempEntityType.DamageDealt && ev.clientNum !== undefined)
        stats.noteDamageDealt({ attacker: ev.clientNum, damage: ev.count! });
};
// layout + centerprint text:
stats.noteText(ev.text); // true ⇒ a new round opened OR the current closed
parser.onFrame    = (ev) => stats.noteScores(ev.teamScores);
stats.snapshot();        // JSON-safe { rounds, totals }
stats.reset();
```

- `GET /stats` → the snapshot (`rounds[]` oldest→newest plus `totals`).
- SSE `stats` — broadcast immediately on obituary/death and coalesced
  (2 s window) for hit updates so a firefight doesn't emit per-print.
- The `/events` snapshot payload carries `stats` for initial paint.

Exported from `index.ts`: `StatsTracker`, `StatsTrackerOptions`,
`StatsSnapshot`, `PlayerRoundStats`, `RoundStats`, `DEFAULT_ROUND_PATTERNS`,
`DEFAULT_END_PATTERNS`.
