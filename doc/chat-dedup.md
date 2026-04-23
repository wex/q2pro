# Chat deduplication in MVD2 playback

## Scope

This note documents how `ts-mvd` dedupes `PRINT_CHAT` events when parsing
MVD2 streams produced by Q2Pro. It applies to any consumer that subscribes
to `MvdFrameParser.onChat` (e.g. the `example.ts` public UI SSE broadcast).

## Problem

`MvdFrameParser.onChat` used to fire once per MVD `svc_print` record. In
practice that meant a single chat line was emitted as many times as there
were active players on the server at the time — the UI chat log grew with
one identical entry per recipient.

## Why the stream contains duplicates

The duplication is introduced on the Q2Pro server side, not in the
wire parser.

When the game (vanilla Quake 2 as well as AQ2:TNG) handles a chat
command, it does not call `gi.bprintf`; instead it walks every connected
player and calls `gi.cprintf(other, PRINT_CHAT, text)` per recipient.
See <ref_snippet file="/home/ubuntu/repos/q2pro/src/game/g_cmds.c" lines="751-799" />
for the base game and <ref_snippet file="/home/ubuntu/repos/q2pro/src/action/g_cmds.c" lines="1475-1517" />
for the AQ2:TNG variant used by the `aqtion` branch.

Each `gi.cprintf(ent, PRINT_CHAT, ...)` lands in `PF_cprintf`
(<ref_snippet file="/home/ubuntu/repos/q2pro/src/server/game.c" lines="231-276" />),
which writes one `svc_print + level + text` payload and forwards it to
the MVD stream via `SV_MvdUnicast`
(<ref_snippet file="/home/ubuntu/repos/q2pro/src/server/mvd.c" lines="1201-1239" />).
Every call produces an independent `mvd_unicast_r` block whose only
distinguishing byte is `clientNum`.

The MVD server's live spectator routing hides this on the server side:
`MVD_UnicastPrint`
(<ref_snippet file="/home/ubuntu/repos/q2pro/src/server/mvd/parse.c" lines="285-323" />)
filters the unicast by `target == player`, so each spectator only sees
the copy addressed to the player they are chasing. `ts-mvd` is a raw
stream consumer with no per-spectator target, so it observes every copy.

## Wire shape of a single chat line

For a server with N active players, one `say`/`say_team` results in the
following MVD sequence within a single tick (simplified):

```
mvd_unicast_r  len  clientNum=0  [svc_print, level=PRINT_CHAT, text]
mvd_unicast_r  len  clientNum=1  [svc_print, level=PRINT_CHAT, text]
…
mvd_unicast_r  len  clientNum=N-1  [svc_print, level=PRINT_CHAT, text]
mvd_frame      …                   // end of tick
```

All N records are byte-for-byte identical except for the `clientNum`
byte in the outer unicast framing; the inner `svc_print` payload
(`level`, `text`) is the same.

## Fix

`MvdFrameParser` now maintains a small per-tick dedup set keyed on
`(level, text)` and clears it on the `mvd_frame` boundary (and on
`serverdata` / explicit `reset()`).

The dedup is applied only inside `emitPrint`'s `PRINT_CHAT` branch and
only gates `onChat`. `onPrint` still fires for every `svc_print` in the
raw stream, so consumers that want to observe the underlying
per-recipient prints (e.g. for diagnostics or protocol tracing) are
unaffected. Other print levels (`LOW`, `MEDIUM`, `HIGH`) and the
derived `onObituary` / `onHit` / `onHitTaken` callbacks are not
deduped — obituaries already arrive via broadcast `mvd_print` and hit
messages legitimately differ per recipient.

The dedup signature uses the full chat text including any trailing
newline, so two different players chatting with the same body in the
same tick still produce two `onChat` events (their `"name: "` prefix
differs).

## Protocol touchpoints

- `MvdOp.Unicast` / `MvdOp.UnicastReliable` (the framing that carries
  the duplicate `svc_print` payloads).
- `SvcOp.Print` at `PrintLevel.Chat = 3` (the inner payload the dedup
  inspects).
- `MvdOp.Frame` (tick boundary used to clear the dedup set).
- `MvdOp.ServerData` (session reset).

## Usage impact

No API change. Consumers of `MvdClient` / `MvdFrameParser` see fewer
redundant `onChat` events without having to maintain their own dedup
state. `example.ts`'s `chatLog` now contains one entry per chat line
regardless of how many players are on the server.

## Non-goals

- Deduplicating `onChat` across frame boundaries (e.g. identical
  messages typed in two consecutive ticks). Those are intentionally
  surfaced — they reflect distinct server events.
- Deduplicating `onPrint`. The raw per-recipient print stream is kept
  intact for advanced consumers.
- Altering server behaviour. The fix lives entirely in `ts-mvd`; the
  Q2Pro C sources under `src/` and `inc/` remain untouched.
