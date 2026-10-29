# ts-mvd code audit #2

Date: 2026-10-29.
Scope: everything under `ts-mvd/` (source, tests, browser client), at commit `bb588187`.
Method: full source read-through; wire parsing cross-checked line-by-line against the C
reference (`src/common/msg.c`, `src/server/mvd/parse.c`, `src/server/mvd/client.c`,
`src/server/mvd.c`, `src/client/parse.c`, `inc/shared/shared.h`) and against the AQ2 game
DLL under `src/action/` (which is what the bundled demo and the target servers run);
plus empirical probes against `assets/demos/demo.mvd2` and against the running HTTP app.

Follows `AUDIT.md` (2026-10-28). Every item marked FIXED there was re-verified as fixed;
nothing below repeats those. This audit shifts focus from wire-format correctness (now
solid) to the *semantic* layer on top of it — stats, obituaries, round detection,
lifecycle/exclusivity, and control-surface hardening.

**Status — resolved 2026-10-29.** All six confirmed bugs and all robustness/design items
were implemented on seven sequentially-merged branches (`854d2f82`…`744c03df`, all on
`main`): `feat/aq2-obituaries`, `fix/centerprint-round-dedup`, `fix/client-lifecycle`,
`fix/control-surface-hardening`, `feat/tent-packet-port`, `fix/demo-pacing-seek`,
`fix/audit2-minors`. Each item below is annotated with its branch; the verification
snapshot and demo probe were re-run post-fix. Feature suggestions 1 and 3–7 landed with
the fix branches; suggestion 2 partially (`TE_DAMAGE_DEALT` parses, no damage column).
The original pre-fix text is kept for the record.

## Verification snapshot (post-fix, commit `744c03df`)

- `npx tsc --noEmit -p tsconfig.test.json` — passes.
- `npm run typecheck:browser` — passes.
- `npm run build` — passes.
- `npx jest` — 16 suites, 255 tests, all pass; `forceExit` removed
  (`closeAppForTests()` releases the app-module handles). One pre-existing flake:
  the compressed-tail case in `client.test.ts` can time out under parallel workers
  (passes in isolation and under `--runInBand`), unchanged from before this audit.
- Node v22.23.3 (package pins `@types/node` ^20; fine).
- Wire format re-verified against the C reference — all of the following match exactly:
  `MSG_ParseDeltaPlayerstate_Packet` (order incl. `PPS_FOG` between blend and fov),
  `MSG_ReadDeltaInt23`, `MSG_ReadStats` (varint64 / u32), `MSG_ReadBlend`, `MSG_ReadFog`,
  `MSG_ParseEntityBits` (5th byte only with `MSG_ES_EXTENSIONS`), `MSG_ParseDeltaEntity`
  (model16, skin/effects/renderfx 8/16/32, delta coords, short angles, sound word with
  loop vol/atten, long solid, morefx/alpha/scale), `MVD_ParseServerData` (u16 flags word
  for version >= 2012, cs terminator), `MVD_ParsePacketPlayers` (`PPS_MOREBITS == PPS_REMOVE`
  on old streams), `MVD_ParseUnicast`/`MVD_ParseMulticast` framing, `MVD_ParseSound`,
  `CL_ParseStartSoundPacket`, `CL_ParseMuzzleFlashPacket` entity-bit folding,
  GTV framing (`msglen == 0` → end of stream, `> MAX_MSGLEN` → drop), `.mvd2` layout.
- Demo probe (`demo.mvd2`, 419 messages / 419 frames, version 2010, flags 0, clientNum 18),
  re-run post-fix: **0 parse warnings, 0 dropped bytes** (regression-free after the TE
  table). Obituaries now attribute: `kills=1` → `weaponKills {"mk23":1}` for
  `mJw - Royce`. `LIGHTS…/CAMERA…/ACTION!` centerprints each emitted once; rounds = 2
  (initial + `ACTION!`) — the MOTD `Timelimit:` text opens none. `Host: a b` → 403
  (previously an uncaught crash). `POST /replay` during reconnect back-off is accepted
  and cancels the pending timer; `Session.mode` reports `live` while armed.
  (Pre-fix probe: 5 obituaries all unattributed, 3 rounds — 2 bogus from the MOTD.)

## Confirmed bugs

### 1. AQ2 kill attribution is dead — `classifyObituary` knows none of the AQ2 templates — FIXED (feat/aq2-obituaries, 854d2f82)
Files: `ts-mvd/src/frame.ts` (`classifyObituary`, lines 1410–1439), `ts-mvd/src/stats.ts`
(`noteObituary`, 145–152), `test/frame.test.ts:214` (codifies the gap as expected).

`src/action/p_client.c` `ClientObituary` builds every kill line as
`"%s%s %s%s\n"` = `victim + message + " " + attacker + message2` (line 1559), where
`message`/`message2` come from a table of ~70 fixed strings (lines 1240–1555), e.g.
`" has a hole in his head from" / "'s Mark 23 pistol"`, `" was shot by" / "'s M4 Assault
Rifle"`, `" was picked off by"`, `" was minched by"`, `" had his throat slit by"`,
`" caught" / "'s handgrenade"`, `" was John Woo'd by"`. The classifier matches only
`was (killed|blown away|shredded|chopped up|perforated|sniped|gunned down|brutalized) by`
plus vanilla verbs, so on an AQ2 server essentially every kill line falls into the
raw-only branch (`victim === ''`, `attacker === null`).

Evidence from the bundled demo (Session pipeline, non-realtime replay):

```
[obit] {"victim":"","attacker":null,"weapon":null,"raw":"fren waters has a hole in his head from mJw - Royce's Mark 23 pistol"}
[obit] {"victim":"","attacker":null,"weapon":null,"raw":"mJw - Royce plummets to his death"}
totals: "mJw - Royce": {kills:0, deaths:1, hits:2, hitsByLocation:{head:2}, weaponsUsed:{}}
        "fren waters": {kills:0, deaths:1}
weaponKills: {}
```

Royce has two head hits and a confirmed MK23 headshot kill, yet `kills: 0` and
`weaponKills` is empty. **The per-round stats feature (`GET /stats`, stats panel) cannot
produce kills or weapon tallies on AQ2 at all** — only deaths (from `STAT_HEALTH`) and
hits (from the `You hit …` prints) work. The kill feed shows the raw line, so this is
invisible in the UI until you look at the stats panel.

Fix: the template table is right there in the C source — generate a data-driven matcher:
`^(.+?)(<message>) (.+?)(<message2>)?$` with the `message` alternation anchored to the
known suffixes, mapped to a weapon token per `MOD_*` (`mk23`, `mp5`, `m4`, `m3`, `hc`,
`ssg`, `dual`, `knife`, `kick`, `punch`, `grenade`, `grapple`, …). Also cover the
world-death table (`plummets to his death`, `was flattened`, `sank like a rock`, `ate too
much glass`, `is done with the world`, `got blasted`, `was in the wrong place`, …) and the
`"%s died"` fallback. Then flip `test/frame.test.ts:214` into a positive test.

### 2. Round detection: false positives on the MOTD, blind to the real AQ2 round start — FIXED (fix/centerprint-round-dedup, ecfaf43e)
Files: `ts-mvd/src/stats.ts` (`DEFAULT_ROUND_PATTERNS`, 65–71), `ts-mvd/src/session.ts`
(`onCenterPrint` 351–353, `onLayout` 344–348), `doc/session-stats.md` §26–29.

Two independent problems, both confirmed on the demo:

(a) `/timelimit/i` matches the server MOTD centerprint, which AQ2 sends to **every
connecting player**:

```
[centerprint f17 cl1]  "AQ2: The Next Generation …\nFraglimit: none  Timelimit: 20\n…" → ROUND /timelimit/i
[centerprint f21 cl18] "AQ2: The Next Generation …\nFraglimit: none  Timelimit: 20\n…" → ROUND /timelimit/i
rounds detected: 3   (rounds 0 and 1 are empty)
```

Every player join (including the MVD dummy at cl18) opens a bogus round. On a busy
server this fragments the stats into dozens of empty rounds and pushes real rounds out of
the `maxRounds=64` window.

(b) AQ2 TNG signals the round start with `CenterPrintAll("LIGHTS...")`,
`"CAMERA..."`, `"ACTION!"` (`src/action/a_team.c:2458/2516/2521`; also `tng_jump.c`,
`a_esp.c`). None of the default patterns match these, so **actual AQ2 teamplay rounds are
never split** — the doc's claim that AQ2 signals via `FIGHT!`/`Round N` is wrong for TNG.

Fix: replace `/timelimit/i` with `/^timelimit hit/i` (the end-of-match broadcast that
`MVD_ParsePrint` itself special-cases, `src/server/mvd/parse.c:593`), add `/^action!?$/i`
as the AQ2 round-start marker, and update `doc/session-stats.md`. Adding `ACTION!` is
only safe together with bug 3.

### 3. Per-recipient centerprint duplicates are not deduped — FIXED (fix/centerprint-round-dedup, ecfaf43e)
Files: `ts-mvd/src/frame.ts` (`parseInnerSvcMessages` `SvcOp.CenterPrint`, 968–974;
`emitPrint` dedup 1015–1034).

`PF_centerprintf` is a unicast, so the MVD stream carries one `mvd_unicast` per recipient
(same mechanism as the chat/obituary duplication fixed in `doc/chat-dedup.md`). The dedup
set only covers `svc_print` at levels CHAT/MEDIUM; `onCenterPrint` fires once per
recipient:

```
[centerprint f201 cl0]  "LIGHTS..."   [centerprint f201 cl18] "LIGHTS..."
[centerprint f222 cl0]  "CAMERA..."   [centerprint f222 cl1]  "CAMERA..."  [cl18] "CAMERA..."
[centerprint f242 cl0]  "ACTION!"     [centerprint f242 cl1]  "ACTION!"    [cl18] "ACTION!"
```

With the pattern fix from bug 2, each round start would open N rounds (one per connected
client). Fix: run centerprint text through the same per-tick `printSeenThisTick` set
(keyed e.g. `cp\x00text`), or dedupe in `Session.onCenterPrint`. Note that `svc_layout`
is *not* affected — `filter_unicast_data` (`src/server/mvd.c:1180`) only records layouts
sent to the dummy.

### 4. A pending auto-reconnect is invisible to the live/replay exclusivity checks — FIXED (fix/client-lifecycle, 493dc48a)
Files: `ts-mvd/src/client.ts` (`softClose` 246–255, `scheduleReconnect` 534–546),
`ts-mvd/src/app.ts` (`/replay` 400–435, `/connect` 333), `ts-mvd/src/session.ts`
(`startReplay` 485–523, `mode` 577–580).

`softClose()` sets `Disconnected` *and then* arms the reconnect timer; nothing exposes
that timer. The app creates the default client with `autoReconnect: true`, so after any
drop the `/replay` guard `client.state !== Disconnected` passes, `startReplay()` does not
tear the client down, and the timer later reconnects **into the same parser the replay is
feeding**. Reproduced against a stub GTV server that accepts and immediately closes:

```
connect → 202
after stub close: client.state = disconnected  mode = idle  accepts = 1
POST /replay while reconnect pending → 202
5.5s later: accepts = 2  currentReplay = true  mode = replay
```

Had the stub been a real server, live frames and demo frames would interleave through
one `MvdFrameParser` (delta state corrupted; SSE shows both). `Session.mode` also reports
`idle` during back-off, so the UI re-opens the session modal while the client is in fact
about to reconnect.

Fix: (1) `startReplay()` (or the `/replay` route) must call `client.disconnect()` first —
it already sets `destroyed` and clears the timer; (2) expose `reconnectPending: boolean`
(or a `Reconnecting` pseudo-state) on `MvdClient` and treat it as "live" in `/replay`,
`/connect` and `Session.mode`.

### 5. A malformed `Host` header crashes the process — FIXED (fix/control-surface-hardening, b27e370e)
File: `ts-mvd/src/app.ts:323` — ``new URL(req.url || '/', `http://${req.headers.host}`)``.

`new URL()` throws on an invalid base and nothing catches it inside the request listener:

```
GET /state HTTP/1.1\r\nHost: a b\r\n\r\n
→ UNCAUGHT EXCEPTION from request handler: Invalid URL   (empty response, process exits)
```

Any local process (or anything that can reach the port when `HTTP_HOST` is widened) can
take the app down with one request. Fix: parse against a constant base
(`new URL(req.url ?? '/', 'http://localhost')` — the host part is never used) and/or
wrap the listener body in try/catch → 400.

### 6. `MvdClient` wedges if a listener calls `disconnect()` from inside `hello`/`connect` — FIXED (fix/client-lifecycle, 493dc48a)
File: `ts-mvd/src/client.ts` (`handleHello` 377–400, `drainRecvBuf` 277–278,
`sendHello` 484, `sendStreamStart` 204).

Both handlers emit, then unconditionally continue mutating state (`setState(Preparing)`,
`sendStreamStart()` → `setState(Ready)`, `startPingTimer()`). Reproduced with a fake GTV
that echoes magic + hello and a `hello` listener that calls `disconnect()`:

```
states: … connected->preparing, preparing->disconnected, disconnected->preparing, preparing->ready
state after disconnect-in-hello: ready        (socket is null)
active Timeout handles: 1                      (ping interval leaked)
connect() after wedge → state: ready           (refused: state !== Disconnected)
```

The instance is permanently unusable and keeps the event loop alive. Same pattern in
`drainRecvBuf`: `emit('connect')` → `sendHello()` → `setState(Preparing)`. Fix: after
every `emit`, bail if `this.destroyed || this._state === Disconnected`; and make
`startPingTimer()`/`sendStreamStart()` no-ops without a socket (the `sendStreamStart` API
tightening left open in AUDIT.md item 8).

## Robustness / design

7. **No CSRF / DNS-rebinding protection on the control surface — `src/app.ts` — FIXED (fix/control-surface-hardening).**
   Every mutating route (`POST /connect`, `/disconnect`, `/replay`, `/replay/control`,
   `/record/start`, `/record/stop`, `DELETE /replay`) accepts cross-origin requests:
   `readJsonBody` ignores `Content-Type`, no `Origin`/`Host` check, no custom-header
   requirement. A web page in the operator's browser can POST a form to
   `http://127.0.0.1:8080/connect` and make the app open a TCP connection + GTV hello
   (with the supplied password) to any host:port, start writing files under
   `assets/demos/` via `/record/start?name=`, or kill the live stream. With DNS
   rebinding the responses (`/state`, `/stats`, `/events`, `/demos`) are readable too.
   Localhost binding (AUDIT.md item 6) limits but does not close this. Fix: reject
   requests whose `Origin`/`Host` is not the bound address, and require
   `Content-Type: application/json` on JSON routes (the browser client already sends it).
   Resolved as specified: constant URL base (`http://localhost`), Host allow-list
   matching the bind address (extendable via `HTTP_ALLOWED_HOSTS`), Origin allow-list,
   JSON content-type enforced with 415 on bodied POSTs. See `doc/app-hardening.md`.
8. **Known AQ2 temp-entities abort the inner svc walk — `src/frame.ts` `parseTempEntity` — FIXED (feat/tent-packet-port).**
   Unknown TE types stop parsing the rest of that unicast/multicast payload (by design),
   but AQ2 emits three fixed-format types the parser does not know:
   `TE_TELEPORT_EFFECT`=48 `[pos]` (jump mode, `tng_jump.c:460`), `TE_GRAPPLE_CABLE`=24
   `[short pos pos pos]` (`g_grapple.c:133`), and `TE_DAMAGE_DEALT`=128 `[short]`
   (hit markers unicast to the attacker, `p_view.c:1703`; the MVD recorder does not
   filter unicast TEs — `filter_unicast_data`, `src/server/mvd.c:1166`). The complete
   format table is `CL_ParseTEntPacket` (`src/client/parse.c:857–994`); all remaining
   Rogue/KEX types are fixed-length too, so the whole table can be ported. None appeared
   in the 42-second demo, but `TE_DAMAGE_DEALT` fires on every hit from a modern Q2Pro
   client. See also suggestion 2. Resolved: the complete `CL_ParseTEntPacket` format
   table was ported (~65 types, declarative `TeFmt` groups) including all three AQ2
   types; `TE_DAMAGE_DEALT` surfaces its `count` field. See `doc/temp-entities.md`.
9. **`svc_muzzleflash2` weapon id truncated — `src/frame.ts:1069` — FIXED (feat/tent-packet-port).** `weapon & 0x7f` is
   only correct for `svc_muzzleflash` (mask = `MZ_SILENCED`). For `svc_muzzleflash2` the
   C client uses mask 0 and monster flash ids run past 127 (`MZ2_*`), and under the
   extended protocol the high byte is deliberately folded in (`weapon |= entity >> 13 << 8`,
   which the parser reconstructs and then masks away again). Harmless on AQ2 (no
   monsters) but the surfaced value is wrong. Mask only when `isPlayerFlash`.
10. **Non-obituary `PRINT_MEDIUM` lines pollute the kill feed — `src/frame.ts` `emitPrint` — FIXED (feat/aq2-obituaries).**
    Every PRINT_MEDIUM broadcast becomes an `ObituaryEvent`; the demo shows
    `"Saving node table..."`, `"done (335 updated)"`, `"done."` (bot nav) and AQ2 also
    uses PRINT_MEDIUM for `"X is now known as Y."` and antilag notices. Once bug 1 gives
    a real template match, lines that match nothing should go to a `print` channel, not
    the kill feed (or be shown with a distinct style). Resolved: unmatched lines emit
    `kind: 'info'` and the kill feed styles them distinctly.
11. **Outbound GTV message size is unchecked — `src/client.ts` `sendMessage`/`sendStringCmd`/
    `sendHello` — FIXED (fix/client-lifecycle).** The server drops the connection on `msglen > MAX_GTC_MSGLEN` (256,
    `src/server/mvd.c:1686`). A long `sendStringCmd()` or a long username/password/version
    triple silently kills the session. Resolved: `sendMessage` rejects oversize
    payloads before writing.
12. **`/events` snapshot ignores `?session=` — `src/app.ts:628` — FIXED (fix/control-surface-hardening).** Always serialised
    `defaultSession`; every other route honours the parameter. Same for the UDP status
    handler (`app.ts:155`), which writes into `defaultSession` unconditionally.
    Resolved: `/events?session=` snapshots the requested session (404 for unknown ids)
    and status replies are attributed to the session they were polled for.
13. **`Session` has no `dispose()` — FIXED (fix/client-lifecycle).** `createSession()` is exported, but a Session owns an
    `MvdClient` (socket, ping/reconnect timers), a `statsTimer`, a recorder fd and a replay
    reader; there is no way to release them, so the multi-session runtime promised by
    `doc/session-refactor.md` will leak until one is added. `Session.dispose()` now stops
    replay, disconnects/detaches the client, clears the stats timer and closes the
    recorder.
14. **Demo pacing is "one message per tick" — `src/demo.ts:255–275` — FIXED (fix/demo-pacing-seek).** Correct for the
    bundled demo (1 `mvd_frame` per message) but a recording made with `Mvd2Writer` from a
    GTV stream stores one `GTS_STREAM_DATA` per message, and a stream that batches several
    frames or sends frame-less messages (configstring bursts, suspend/resume) will
    play back too fast/slow. Resolved: pacing is per `mvd_frame` op (first byte `&
    SVCMD_MASK`); messages containing N frames emit in one burst.
15. **Seek only snaps to `mvd_serverdata` — FIXED (fix/demo-pacing-seek).** `buildKeyframes()` finds serverdata (and the
    reserved `framenodelta`), so on a single-map demo any seek goes back to message 0 and
    replays from there in realtime. Resolved as suggested: after snapping, messages up to
    the target are parsed with `catchup=true` (Session suppresses SSE), then realtime
    playback resumes; a `seeked` event signals completion.
16. **Minor — all FIXED (fix/audit2-minors, 744c03df).**
    - `FrameEvent.players[i].stats` is the parser's live `Int16Array` (the spread copies
      the reference); consumers that retain frames see later mutations. Copy or document.
    - `public/app.js` `loadoutIconHtml` builds an inline `onerror` handler containing an
      HTML-escaped label inside a JS string literal — `&#39;` is decoded back to `'` by
      the HTML parser before JS sees it. Safe today only because labels come from a fixed
      table; prefer an `error` listener.
    - `isStatusReplySource` only checks the port when the target is a hostname; any host
      can spoof the serverinfo/player list (HTML-escaped, so display-only).
    - `tsx` is a runtime `dependency` while `npm run app` uses `ts-node`; the library
      needs neither at runtime — move to devDependencies.
    - `jest` `forceExit: true` hides the import-time `udpSock` / `sseHeartbeat` handles in
      `app.ts`; a `closeAppForTests()` that closes them would let `forceExit` go.

## Test gaps — all closed

- ~~No test feeds a real AQ2 obituary through `StatsTracker` end-to-end; `frame.test.ts:214`~~
  asserts the *failure* mode (bug 1). Add fixtures for a dozen `ClientObituary` templates
  (one per `MOD_*`), including names containing `'s`, ` by `, and ` from `.
  → `aq2-obituaries.test.ts` (template parity vs `p_client.c`, hostile names, world /
  suicide / info) + end-to-end frame→stats assertions in `frame.test.ts` /
  `stats.test.ts`.
- ~~No test for per-recipient centerprint duplicates (bug 3) or for a MOTD centerprint not~~
  opening a round (bug 2a); the existing `'timelimit hit'` case (`stats.test.ts:96`)
  would still pass with the anchored pattern, so it does not pin the behaviour down.~~
  → dedup + MOTD/ACTION!/match-end cases in `frame.test.ts` / `stats.test.ts`.
- ~~No test for the replay-during-reconnect race (bug 4) — `client.test.ts` covers back-off
  escalation but never combines it with `startReplay`.~~ → `app.test.ts` drives a
  pending-reconnect + `/replay` (timer cancelled) and `/state` reporting `live`.
- ~~No test for `disconnect()` from inside a client event listener (bug 6).~~ →
  `client.test.ts` covers reentrant disconnect from `connect`/`hello`/`streamStop`.
- ~~No HTTP-level test with a malformed `Host` header or a cross-origin `Origin` (bugs 5/7).~~
  → `app.test.ts`: malformed/foreign Host → 403, foreign Origin → 403, wrong
  Content-Type → 415, `/events?session=` scoping.
- ~~`parseTempEntity`: only `TE_BLOOD`/`TE_SPARKS`-class types are exercised; no test for a
  two-point TE followed by another op, nor for any of the AQ2 types in item 8.~~ →
  `frame.test.ts` exercises every `TeFmt` group, all three AQ2 types, TE-followed-by-op
  continuation, truncation, and muzzleflash2 masks.
- ~~`demo.ts` realtime pacing and seek still untested (carried over from AUDIT.md).~~ →
  `demo.test.ts` covers frame-boundary pacing bursts and silent catch-up seek;
  `session.test.ts` covers broadcast suppression during catch-up.

## Feature suggestions

Status as of 2026-10-29: 1, 3–7 implemented on the fix branches above. 2 is partially
in place — `TE_DAMAGE_DEALT` parses and surfaces `count`, but no per-round damage
column was built (remains a future item). Within 3, `ACTION!` opens rounds and
match-end broadcasts close them, but `teamScores` on `RoundStats` was not added.
Within 6, a `reconnectPending` getter was chosen over a separate `Reconnecting`
state; `Session.dispose()` landed.

1. **Table-driven AQ2 obituary parser** (fixes bug 1). Port the `ClientObituary` table
   from `src/action/p_client.c` into a `src/aq2-obituaries.ts` module with a parity test
   that greps the C source so the table cannot silently drift. Emits
   `{victim, attacker, weapon, mod, headshot, friendlyFire?}`.
2. **Exact damage numbers from `TE_DAMAGE_DEALT`.** AQ2 unicasts the attacker a
   `[short damage]` TE on every hit (`p_view.c:1697–1708`). Parsing it (item 8) yields
   per-hit damage attribution far better than the nearest-player heuristic in
   `combat-fx.ts`, and a "damage dealt per round" column for the stats panel.
3. **Round detection from AQ2's own signals** (fixes bug 2): `ACTION!` opens a round;
   `"The round is over"` / team-score `STAT_TEAM{1,2}_SCORE` deltas close it; carry
   `teamScores` into `RoundStats` so the stats panel can show who won each round.
4. **Replay fast-forward seek** (item 15) — silent catch-up parse from the keyframe,
   then resume realtime; plus `mvd_frame`-based pacing (item 14).
5. **Control-surface hardening bundle** (bugs 5/7, item 11): constant URL base,
   Origin/Host allow-list, JSON content-type enforcement, outbound GTV size clamp.
6. **`MvdClient` lifecycle tightening** (bugs 4/6): `reconnectPending` getter,
   `Reconnecting` state in `stateChange`, re-entrancy guards after each `emit`,
   `Session.dispose()` (item 13).
7. **Full `CL_ParseTEntPacket` port** (item 8) so no TE type can ever stop the inner walk;
   surface `entity`/`count`/`color` on `TempEntityEvent`.

## Prioritized TODO

1. ~~Bug 1 — AQ2 obituary table + stats kill attribution~~ — done (`feat/aq2-obituaries`).
2. ~~Bugs 2 + 3 together — centerprint dedup, `ACTION!` pattern, `^timelimit hit` anchor,
   doc fix.~~ — done (`fix/centerprint-round-dedup`).
3. ~~Bug 4 — disconnect before replay; expose reconnect-pending; fix `Session.mode`.~~ —
   done (`fix/client-lifecycle`).
4. ~~Bug 5 + item 7 — URL parsing hardening and Origin/Content-Type checks~~ — done
   (`fix/control-surface-hardening`).
5. ~~Bug 6 + items 11/13 — client re-entrancy guards, outbound size clamp, `Session.dispose()`.~~
   — done (`fix/client-lifecycle`).
6. ~~Items 8/9 — TE table port~~ and the muzzleflash2 mask fix — done
   (`feat/tent-packet-port`); "then suggestion 2" remains open (parse side landed, the
   stats column did not).
7. ~~Items 14/15 — frame-based pacing and fast-forward seek.~~ — done
   (`fix/demo-pacing-seek`).
8. ~~Tests for every item above; item 16 minors~~ — done; suite grew 194 → 255 and
   `forceExit` is gone (`fix/audit2-minors`).
