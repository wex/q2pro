# MVD Demo Recording and Broadcasting System

## Overview

The MVD (Multi-View Demo) system in Q2Pro provides server-side demo recording and
live game broadcasting. Unlike traditional client-side demos that capture a single
player's perspective, MVD records **all** entity states, player states, and game
events simultaneously, enabling spectators to freely switch between player views
during playback.

The system has two major subsystems:

1. **Server-side MVD Recorder** (`src/server/mvd.c`) — captures game state on a
   live server, writes `.mvd2` demo files, and serves live streams to GTV clients
   over TCP.
2. **MVD Client / GTV Relay** (`src/server/mvd/client.c`, `parse.c`, `game.c`) —
   connects to an upstream GTV server (or plays back `.mvd2` files), parses the
   MVD stream, and presents it to connected UDP spectators as a virtual game
   server (`ss_broadcast` state).

```
┌──────────────┐         GTV/TCP          ┌──────────────────┐      UDP
│  Game Server  │ ───────────────────────▶ │  GTV Relay/MVD   │ ◀──────────
│  (ss_game)    │   MVD stream over TCP    │  Client Server   │   Spectators
│               │                          │  (ss_broadcast)  │
│  ┌──────────┐ │                          └──────────────────┘
│  │ MVD      │ │──▶ .mvd2 demo file
│  │ Recorder │ │
│  └──────────┘ │
└──────────────┘
```

---

## File Layout

| File | Role |
|---|---|
| `src/server/mvd.c` | GTV server, local MVD recorder, dummy client, frame emission, game API hooks |
| `src/server/mvd/client.c` | GTV client (TCP connection to upstream), demo player, operator commands |
| `src/server/mvd/client.h` | Internal shared types: `mvd_t`, `mvd_client_t`, `mvd_player_t`, `mvd_snap_t` |
| `src/server/mvd/parse.c` | MVD stream parser — serverdata, frames, multicast, unicast, sound, print |
| `src/server/mvd/game.c` | Virtual game DLL for spectators: chase cam, layouts, menus, channels |
| `inc/server/mvd/protocol.h` | GTV wire protocol: opcodes, version, message limits |
| `inc/server/mvd/client.h` | Public API exported to the rest of the server |
| `inc/common/protocol.h` | MVD protocol version constants, `mvd_ops_t` enum, `mvd_flags_t` |

---

## Part 1: Server-Side MVD Recording (`src/server/mvd.c`)

### 1.1 Enabling MVD

Controlled by `sv_mvd_enable`:
- **0** — disabled (default).
- **1** — local recording only (no TCP listener).
- **2** — local recording + TCP listener for GTV clients.

When `sv_mvd_enable >= 2`, `SV_MvdPreInit()` opens a TCP listen socket and
allocates a pool of `sv_mvd_maxclients` GTV client slots.

### 1.2 The Dummy MVD Client

A central concept is the **MVD dummy** — a fake client connected to the game
server that acts as a spectator proxy. It:

- Occupies a reserved player slot (controlled by `sv_mvd_spawn_dummy`).
- Connects with userinfo `\name\[MVDSPEC]\skin\male/grunt\spectator\1`.
- Receives scoreboard layouts, print messages, and stufftext from the game DLL.
- Runs `ClientThink` every frame to prevent timeouts.
- Periodically re-requests the scoreboard via `sv_mvd_scorecmd`.
- Processes stufftext commands through a private command buffer (`dummy_buffer`).
- Supports auto-recording via the `record`/`stop` stufftext commands when
  `sv_mvd_autorecord` is enabled.

The dummy is created in `dummy_create()`, spawned in `dummy_spawn()`, and ticked
every frame in `dummy_run()`.

### 1.3 Frame Capture Pipeline

Each server frame, the MVD recorder captures the full game state:

```
SV_MvdBeginFrame()          — check client/player activity, suspend/resume
  ├─ check_clients_activity()   — disconnect dummy if no GTV clients for too long
  └─ check_players_activity()   — suspend stream if no players active

SV_MvdEndFrame()            — build and distribute the frame
  ├─ dummy_run()                — tick the dummy's command buffer
  ├─ emit_frame()               — delta-compress all entities and players
  ├─ FOR_EACH_ACTIVE_GTV        — send frame to TCP clients
  └─ rec_frame()                — write frame to local demo file
```

#### Delta Compression

MVD operates over reliable transport (TCP / file), so there are **no baselines**
in the traditional sense. Delta compression is always from the last state on this
map. The first frame after a map change (`emit_gamestate()`) is a full
uncompressed baseline. Subsequent frames (`emit_frame()`) are delta-compressed
against the previous state stored in `mvd.players[]` and `mvd.entities[]`.

**Bandwidth optimization**: For player entities with `PM_NORMAL`, origin and
angles are stripped from entity state updates (`MSG_ES_FIRSTPERSON` flag) since
the MVD client can reconstruct them from the corresponding player state.

### 1.4 Message Buffers

The MVD recorder maintains two message buffers:

- **`mvd.message`** (reliable) — configstrings, unicast reliable data, print
  messages. Must not be discarded.
- **`mvd.datagram`** (unreliable) — multicast effects, sounds, unreliable
  unicasts. Can be dropped if the frame overflows.

Each frame sent to GTV clients or written to a demo file contains:
`[mvd.message] + [emit_frame() output] + [mvd.datagram]`

### 1.5 Game API Hooks

These functions intercept game DLL calls and inject data into the MVD stream:

| Hook | Purpose |
|---|---|
| `SV_MvdMulticast()` | Captures PVS/PHS multicasts (effects, temp entities) |
| `SV_MvdUnicast()` | Captures per-client messages (layouts, prints, stufftext) |
| `SV_MvdConfigstring()` | Captures configstring changes |
| `SV_MvdBroadcastPrint()` | Captures broadcast print messages |
| `SV_MvdStartSound()` | Captures entity-relative sounds |

`SV_MvdUnicast()` applies filtering via `filter_unicast_data()`:
- Stufftext is discarded (except `play` sound hacks).
- Layouts to non-dummy players are discarded.
- Print messages to non-dummy players are optionally discarded (`sv_mvd_nomsgs`).

### 1.6 Stream Suspension

When no real players are active for longer than `sv_mvd_suspend_time`, the stream
is **suspended**:
- An empty `GTS_STREAM_DATA` message is sent (zero-length data marker).
- `mvd.active` is set to `false`; no frames are emitted.

When players rejoin, `resume_streams()` rebuilds the full gamestate from scratch
and sends it to all active GTV clients and the demo file.

### 1.7 Local Demo Recording

Commands:
- **`mvdrecord [-z] <filename>`** — begin recording to `demos/<filename>.mvd2`.
  The `-z` flag enables gzip compression.
- **`mvdstop`** — stop recording.

Recording lifecycle:
1. `rec_start()` — writes the 4-byte `MVD_MAGIC` (`'MVD2'`), then the full
   gamestate if the stream is active.
2. `rec_frame()` — called each frame from `SV_MvdEndFrame()`. Writes a 16-bit
   little-endian message length followed by the concatenation of reliable +
   frame + datagram data.
3. `rec_stop()` — writes a 16-bit zero as an EOF marker and closes the file.

Automatic limits: `sv_mvd_maxsize` (bytes), `sv_mvd_maxtime` (frames),
`sv_mvd_maxmaps` (level changes).

### 1.8 Player Activity Detection

`player_is_active()` determines which players are captured into the MVD stream.
This is a heuristic since the game DLL doesn't expose this directly:

1. Entity must be in use and have a client pointer.
2. If `sv_mvd_capture_flags & 1`: client must be in `cs_spawned` state.
3. FOV must be non-zero (validates player state).
4. The MVD dummy is always captured.
5. Spectators (`PM_SPECTATOR`) are never captured.
6. Invisible entities (`SVF_NOCLIENT` / no effects) are filtered by flag bits.
7. `PM_FREEZE` or `PMF_NO_PREDICTION` implies the player is following someone.

---

## Part 2: GTV Wire Protocol (`inc/server/mvd/protocol.h`)

### 2.1 Connection Handshake

```
Client                          Server
  │                               │
  │──── MVD_MAGIC (4 bytes) ────▶│  (0x4D564432 = 'MVD2')
  │◀─── MVD_MAGIC (4 bytes) ─────│  (echo back)
  │                               │
  │──── GTC_HELLO ──────────────▶│  protocol, flags, name, password, version
  │◀─── GTS_HELLO ───────────────│  negotiated flags
  │         or GTS_NOACCESS       │
  │         or GTS_BADREQUEST     │
  │                               │
  │──── GTC_STREAM_START ───────▶│  maxbuf
  │◀─── GTS_STREAM_START ────────│  ack
  │◀─── GTS_STREAM_DATA ─────────│  full gamestate + baseline frame
  │◀─── GTS_STREAM_DATA ─────────│  delta frames (continuous)
  │         ...                   │
```

Protocol version: `GTV_PROTOCOL_VERSION = 0xED04`

### 2.2 Message Format

All messages use a 3-byte header: `[uint16_t length][uint8_t opcode]`
followed by `length - 1` bytes of payload.

### 2.3 Server Opcodes (`gtv_serverop_t`)

| Opcode | Name | Description |
|---|---|---|
| 0 | `GTS_HELLO` | Server hello response with negotiated flags |
| 1 | `GTS_PONG` | Ping reply |
| 2 | `GTS_STREAM_START` | Stream start acknowledgment |
| 3 | `GTS_STREAM_STOP` | Stream stop acknowledgment |
| 4 | `GTS_STREAM_DATA` | MVD stream data (gamestate or delta frame) |
| 5 | `GTS_ERROR` | Server-side error, connection will be dropped |
| 6 | `GTS_BADREQUEST` | Bad protocol version |
| 7 | `GTS_NOACCESS` | Authentication failed |
| 8 | `GTS_DISCONNECT` | Server shutting down |
| 9 | `GTS_RECONNECT` | Server restarting, client should reconnect |

### 2.4 Client Opcodes (`gtv_clientop_t`)

| Opcode | Name | Description |
|---|---|---|
| 0 | `GTC_HELLO` | Client hello with protocol, flags, credentials |
| 1 | `GTC_PING` | Keepalive ping |
| 2 | `GTC_STREAM_START` | Request to start receiving stream data |
| 3 | `GTC_STREAM_STOP` | Request to stop receiving stream data |
| 4 | `GTC_STRINGCMD` | Forward a command to the game server |

### 2.5 Negotiation Flags

| Flag | Value | Description |
|---|---|---|
| `GTF_DEFLATE` | 1 | Enable zlib compression on the stream |
| `GTF_STRINGCMDS` | 2 | Allow forwarding string commands to game server |

### 2.6 Stream Suspend/Resume

- An empty `GTS_STREAM_DATA` (header only, no payload) acts as a **suspend
  marker** — no players are active on the server.
- A non-empty `GTS_STREAM_DATA` after suspension acts as a **resume marker**,
  containing a fresh gamestate.

---

## Part 3: MVD File Format (`.mvd2`)

### 3.1 Structure

```
[4 bytes]  MVD_MAGIC = 'MVD2' (0x4D564432)
[message]* sequence of length-prefixed messages
[2 bytes]  0x0000 = EOF marker
```

Each message:
```
[uint16_t]  message length (little-endian), 0 = EOF
[N bytes]   MVD message data (sequence of mvd_ops_t commands)
```

### 3.2 MVD Command Opcodes (`mvd_ops_t`)

Each byte in a message encodes: `opcode = byte & 0x1F`, `extrabits = byte >> 5`.

| Opcode | Name | Description |
|---|---|---|
| 0 | `mvd_bad` | Invalid |
| 1 | `mvd_nop` | No operation |
| 4 | `mvd_serverdata` | Full gamestate (map change) |
| 5 | `mvd_configstring` | Configstring update |
| 6 | `mvd_frame` | Delta-compressed frame (portalbits + players + entities) |
| 8 | `mvd_unicast` | Unreliable per-client data |
| 9 | `mvd_unicast_r` | Reliable per-client data |
| 10–15 | `mvd_multicast_*` | Multicast effects (all/PHS/PVS, reliable/unreliable) |
| 16 | `mvd_sound` | Entity-relative sound |
| 17 | `mvd_print` | Broadcast print message |

### 3.3 Gamestate Message (`mvd_serverdata`)

Written at the start of each map:

```
[byte]    mvd_serverdata (+ flags in extrabits for old versions)
[int32]   PROTOCOL_VERSION_MVD (37)
[uint16]  minor version (2009–2013)
[uint16]  MVD flags (for version >= 2012: MVF_NOMSGS, MVF_EXTLIMITS, etc.)
[int32]   spawncount (server instance ID)
[string]  gamedir
[int16]   dummy client number (-1 if none)
[configstrings]  index/string pairs terminated by csr->end sentinel
[frame]   baseline frame (portalbits + full player states + full entity states)
```

### 3.4 Delta Frame (`mvd_frame`)

```
[byte]     mvd_frame
[byte]     portalbytes count
[N bytes]  portal visibility bits
[players]  delta-compressed player states, terminated by CLIENTNUM_NONE
[entities] delta-compressed entity states, terminated by 0x0000
```

### 3.5 MVD Stream Flags (`mvd_flags_t`)

| Flag | Bit | Description |
|---|---|---|
| `MVF_NOMSGS` | 0 | Don't route player messages to spectators |
| `MVF_SINGLEPOV` | 1 | Single point-of-view recording |
| `MVF_EXTLIMITS` | 2 | Extended protocol limits (long solids, short angles) |
| `MVF_EXTLIMITS_2` | 3 | Further extensions (new game API support) |

### 3.6 Protocol Versions

| Version | Value | Features |
|---|---|---|
| `MINIMUM` | 2009 | Base MVD support |
| `DEFAULT` | 2010 | Standard version |
| `EXTENDED_LIMITS` | 2011 | Extended entity/player state encoding |
| `EXTENDED_LIMITS_2` | 2012 | New game API, flags field in serverdata |
| `PLAYERFOG` | 2013 | Player fog support, `MSG_PS_MOREBITS` |

---

## Part 4: GTV Client / MVD Relay (`src/server/mvd/client.c`)

### 4.1 Connection Types

The GTV client subsystem supports two source types:

- **Network connections** (`gtv_run`) — connect to an upstream Q2Pro server's TCP
  port and receive a live MVD stream.
- **Demo playback** (`demo_read_frame`) — read `.mvd2` files from disk.

Both create an `mvd_t` channel that spectators can join.

### 4.2 GTV Connection Lifecycle

States (`gtv_state_t`):
```
DISCONNECTED → CONNECTING → PREPARING → CONNECTED → RESUMING → READING
                                         ↕                      ↕
                                      SUSPENDING ← ─ ─ ─ ─  WAITING
```

- **CONNECTING** — TCP `connect()` in progress.
- **PREPARING** — waiting for server hello after sending magic + `GTC_HELLO`.
- **CONNECTED** — idle, authenticated. Sends `GTC_STREAM_START` when
  `mvd_active` is true.
- **RESUMING** — stream start request sent, waiting for ack.
- **READING** — actively receiving stream data.
- **WAITING** — server suspended the stream (no active players).
- **SUSPENDING** — stream stop request sent.

Reconnection uses exponential backoff: starts at 5s (`GTV_DEFAULT_BACKOFF`),
increases by 15–30s per failure, caps at 5 hours (`GTV_MAXIMUM_BACKOFF`).

### 4.3 Delay Buffer

When receiving live stream data, frames are **not parsed immediately**. Instead
they are queued in a FIFO delay buffer (`mvd->delay`) and consumed one frame per
server tick in `gtv_read_frame()`.

This provides resilience against network jitter:
- **Underflow** (buffer empty): enters `MVD_WAITING` state, buffers
  `min_packets` frames before resuming. Underflow count is tracked and increases
  the minimum buffer threshold.
- **Overflow** (buffer full): clears the entire buffer, sends
  `GTC_STREAM_STOP`, and re-requests the stream.

Buffer size: `mvd_buffer_size` × `MAX_MSGLEN` bytes (default 2 × 65536).

### 4.4 Demo Playback

Commands:
- **`mvdplay <file> [file2 ...]`** — play one or more `.mvd2` files as a
  playlist with optional looping.
- **`mvdpause [chanid]`** — toggle pause on a demo channel.
- **`mvdseek <[+-]offset> [chanid]`** — seek by time or percentage.

Features:
- **Snapshots** (`demo_emit_snapshot`): periodically saves a reconstructed
  baseline frame + configstrings + layout at the current file position. Used for
  fast seeking via binary search (`demo_find_snapshot`).
- **Map skipping** (`demo_skip_map`): scans forward for the next
  `mvd_serverdata` to skip entire maps.
- **Playlist looping**: `demoloop` counter decrements each time the playlist
  wraps; 0 = infinite.

### 4.5 Channel Recording

While relaying a GTV stream, the relay can simultaneously record to a local
`.mvd2` file:
- **`mvdrecord <filename> [chanid]`** — record the specified channel.
- **`mvdstop [chanid]`** — stop recording.

This uses `emit_gamestate()` to write a fresh gamestate, then `MVD_StopRecord()`
to finalize with a zero-length EOF marker.

---

## Part 5: MVD Stream Parsing (`src/server/mvd/parse.c`)

### 5.1 Message Dispatch

`MVD_ParseMessage()` reads commands from the message buffer in a loop:

| Command | Handler | Notes |
|---|---|---|
| `mvd_serverdata` | `MVD_ParseServerData` | Full map change, clears state |
| `mvd_frame` | `MVD_ParseFrame` | Delta players + entities + portalbits |
| `mvd_configstring` | `MVD_ParseConfigstring` | Global configstring update |
| `mvd_unicast[_r]` | `MVD_ParseUnicast` | Per-client data: layouts, prints, configstrings, stufftext |
| `mvd_multicast_*` | `MVD_ParseMulticast` | PVS/PHS-culled effects |
| `mvd_sound` | `MVD_ParseSound` | Entity sounds with position reconstruction |
| `mvd_print` | `MVD_ParsePrint` | Broadcast prints, match-end detection |

### 5.2 Serverdata Parsing

`MVD_ParseServerData()`:
1. Clears all previous state (`MVD_ClearState`).
2. Validates protocol version.
3. Parses flags, spawncount, gamedir, dummy client number.
4. Reads all configstrings.
5. Determines `maxclients` and allocates player array.
6. Loads the BSP for visibility testing.
7. Parses the spawn point from the entity string.
8. Parses the baseline frame.
9. Triggers `MVD_ChangeLevel()` to reconnect all spectators.

### 5.3 Frame Parsing

`MVD_ParseFrame()`:
1. Reads and applies portal visibility bits.
2. `MVD_ParsePacketPlayers()` — delta-decompresses each player state.
3. `MVD_ParsePacketEntities()` — delta-decompresses each entity state.
4. `MVD_PlayerToEntityStates()` — reconstructs entity origins/angles from
   player states for `PM_NORMAL` players (the `MSG_ES_FIRSTPERSON` inverse).
5. `MVD_UpdateClients()` — updates all connected spectators' view states.

### 5.4 Demo Seeking

When `mvd->demoseeking` is true, most side effects are suppressed:
- Multicast, sound, print, unicast messages are silently consumed.
- Configstring changes are tracked in a dirty bitset (`mvd->dcs`) for later
  replay.
- Entity linking is skipped.
- Client updates are skipped.

This allows rapid scanning through frames to reach a target position.

---

## Part 6: Spectator Game Interface (`src/server/mvd/game.c`)

### 6.1 Virtual Game DLL

The MVD subsystem provides a `game_export_t` (`mvd_ge`) that replaces the real
game DLL when the server is in `ss_broadcast` mode. This enables spectators to
connect via standard Q2 UDP protocol and interact with the MVD stream.

### 6.2 Spectator Features

- **Chase camera**: follow any active player, auto-switch on death.
- **Free-float**: spectator movement using `PM_SPECTATOR`.
- **Channel switching**: when multiple GTV connections exist, spectators can
  switch between channels.
- **Layouts**: scoreboard display, client list, channel chooser menu.
- **Flood protection**: rate-limited chat.

### 6.3 Layout Types

| Type | Description |
|---|---|
| `LAYOUT_NONE` | No layout displayed |
| `LAYOUT_FOLLOW` | Chase target name overlay |
| `LAYOUT_SCORES` | Current scoreboard from the MVD dummy |
| `LAYOUT_OLDSCORES` | Saved scoreboard from intermission |
| `LAYOUT_MENU` | Main MVD menu |
| `LAYOUT_CLIENTS` | Connected spectators list |
| `LAYOUT_CHANNELS` | Channel chooser |

---

## Part 7: Configuration Reference

### Server-side CVars (`sv_mvd_*`)

| Cvar | Default | Description |
|---|---|---|
| `sv_mvd_enable` | 0 | 0=off, 1=recording only, 2=recording+TCP |
| `sv_mvd_maxclients` | 8 | Max GTV TCP clients |
| `sv_mvd_bufsize` | 2 | TCP send buffer multiplier (1–4 × MAX_MSGLEN) |
| `sv_mvd_password` | "" | Password for GTV clients |
| `sv_mvd_noblend` | 0 | Strip screen blends from player states |
| `sv_mvd_nogun` | 0 | Strip gun model/frames from player states |
| `sv_mvd_nomsgs` | 1 | Discard print messages to non-dummy players |
| `sv_mvd_maxsize` | 0 | Max demo file size in KB (0=unlimited) |
| `sv_mvd_maxtime` | 0 | Max recording duration in minutes (0=unlimited) |
| `sv_mvd_maxmaps` | 1 | Stop recording after N map changes |
| `sv_mvd_begincmd` | "wait 50;..." | Stufftext sent to dummy on spawn |
| `sv_mvd_scorecmd` | "putaway;..." | Stufftext to refresh scoreboard |
| `sv_mvd_autorecord` | 0 | Enable auto-recording via game stufftext |
| `sv_mvd_capture_flags` | 5 | Bitfield controlling player capture heuristics |
| `sv_mvd_disconnect_time` | 15 | Seconds before disconnecting idle dummy |
| `sv_mvd_suspend_time` | 5 | Seconds before suspending stream with no players |
| `sv_mvd_allow_stufftext` | 0 | Allow game stufftext to dummy (0=deny) |
| `sv_mvd_spawn_dummy` | 1 | 0=no dummy, 1=if game supports, 2=force |

### Client-side / Relay CVars (`mvd_*`)

| Cvar | Description |
|---|---|
| `mvd_timeout` | Connection timeout for upstream GTV |
| `mvd_suspend_time` | Time before suspending inactive relay |
| `mvd_wait_delay` | Minimum packets to buffer before playing |
| `mvd_wait_percent` | Buffer fullness percentage to start playing |
| `mvd_buffer_size` | Delay buffer size multiplier |
| `mvd_username` | Default GTV authentication username |
| `mvd_password` | Default GTV authentication password |
| `mvd_snaps` | Interval in seconds between demo snapshots |

### Server Commands

| Command | Description |
|---|---|
| `mvdrecord [-z] <file>` | Start local MVD recording |
| `mvdstop` | Stop local MVD recording |
| `mvdstuff <cmd>` | Send command to dummy client |
| `addgtvhost <addr>` | Whitelist a GTV client address |
| `delgtvhost <addr>` | Remove from whitelist |
| `addgtvban <addr>` | Blacklist a GTV client address |
| `delgtvban <addr>` | Remove from blacklist |

### Relay/Client Commands

| Command | Description |
|---|---|
| `mvdconnect [-n name] [-u user] [-p pass] <addr>` | Connect to upstream GTV |
| `mvdisconnect [-a] [connid]` | Disconnect from upstream |
| `mvdplay <file> [file2 ...]` | Play demo file(s) |
| `mvdpause [chanid]` | Pause/resume demo playback |
| `mvdseek <offset> [chanid]` | Seek in demo |
| `mvdrecord [-z] <file> [chanid]` | Record a relayed stream |
| `mvdstop [chanid]` | Stop recording relayed stream |
| `mvdkill [chanid]` | Destroy a channel |
| `mvdchannels [r]` | List channels (r=recordings) |
| `mvdservers` | List GTV connections |

---

## Part 8: Authentication and Access Control

GTV client authentication (`auth_client()`):

1. **Whitelisted** addresses are always allowed (no password needed).
2. **Blacklisted** addresses are always denied.
3. If `sv_mvd_password` is empty, all neutral hosts are allowed.
4. Otherwise, the client-provided password must match `sv_mvd_password`.

IP rate limiting via `sv_iplimit`: restricts connections per IPv4 address or
/48 IPv6 network.

---

## Part 9: Zlib Compression

When both sides support it (`GTF_DEFLATE`):
- **Server → Client**: the TCP stream is deflated after the `GTS_HELLO` response.
  Periodic `Z_SYNC_FLUSH` ensures data is available for reading.
- **Client → Server**: the received TCP stream is inflated into a secondary FIFO
  buffer (`gtv->z_buf`) before message parsing.

This significantly reduces bandwidth for live broadcasting.

---

## Part 10: Key Data Structures

### `mvd_server_t` (server-side, singleton `mvd`)
The main server-side MVD state. Contains reliable/unreliable message buffers,
delta compressor state (`players[]`, `entities[]`), local recording handle, and
the GTV TCP client pool.

### `mvd_t` (client-side, one per channel)
Represents a single MVD channel (either from a network connection or demo file).
Contains the full reconstructed game state: configstrings, edicts, player states,
collision map, delay buffer, demo recording state, and the list of connected
UDP spectators.

### `gtv_t` (client-side GTV connection)
Represents a connection to an upstream GTV server or a demo file source. Contains
network stream, zlib state, reconnection backoff, and demo playback state
(playlist, progress, snapshots).

### `gtv_client_t` (server-side TCP client)
Represents a connected GTV downstream client. Contains network stream, zlib
deflate state, send buffer, and authentication info.

### `mvd_client_t` (spectator)
Represents a UDP spectator connected to the MVD relay. Contains chase target,
layout state, flood protection, and player state for freefloat movement.
