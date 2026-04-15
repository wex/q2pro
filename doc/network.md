# Table of Contents

- [Table of Contents](#table-of-contents)
- [About](#about)
- [Protocol Versions](#protocol-versions)
  - [Major Versions](#major-versions)
  - [Minor Versions](#minor-versions)
  - [Extended Protocol Versions](#extended-protocol-versions)
- [Connection Handshake](#connection-handshake)
  - [Out-of-Band Packets](#out-of-band-packets)
  - [Challenge Request](#challenge-request)
  - [Challenge Response](#challenge-response)
  - [Connect Request](#connect-request)
  - [Connect Response](#connect-response)
  - [Entering the Game](#entering-the-game)
  - [Other Connectionless Packets](#other-connectionless-packets)
- [Netchan Layer](#netchan-layer)
  - [Old Netchan (NETCHAN\_OLD)](#old-netchan-netchan_old)
  - [New Netchan (NETCHAN\_NEW)](#new-netchan-netchan_new)
  - [Reliable Message Delivery](#reliable-message-delivery)
  - [Fragmentation](#fragmentation)
  - [Qport](#qport)
- [Server-to-Client Messages](#server-to-client-messages)
  - [svc\_serverdata](#svc_serverdata)
  - [svc\_frame (Protocol 34)](#svc_frame-protocol-34)
  - [svc\_frame (Enhanced Protocols)](#svc_frame-enhanced-protocols)
  - [svc\_playerinfo](#svc_playerinfo)
  - [svc\_packetentities](#svc_packetentities)
  - [svc\_spawnbaseline](#svc_spawnbaseline)
  - [svc\_configstring](#svc_configstring)
  - [svc\_configstringstream](#svc_configstringstream)
  - [svc\_baselinestream](#svc_baselinestream)
  - [svc\_gamestate](#svc_gamestate)
  - [svc\_sound](#svc_sound)
  - [svc\_print](#svc_print)
  - [svc\_stufftext](#svc_stufftext)
  - [svc\_centerprint](#svc_centerprint)
  - [svc\_download](#svc_download)
  - [svc\_zpacket](#svc_zpacket)
  - [svc\_zdownload](#svc_zdownload)
  - [svc\_muzzleflash / svc\_muzzleflash2](#svc_muzzleflash--svc_muzzleflash2)
  - [svc\_temp\_entity](#svc_temp_entity)
  - [svc\_layout](#svc_layout)
  - [svc\_inventory](#svc_inventory)
  - [svc\_setting](#svc_setting)
  - [svc\_reconnect / svc\_disconnect / svc\_nop](#svc_reconnect--svc_disconnect--svc_nop)
- [Client-to-Server Messages](#client-to-server-messages)
  - [clc\_move](#clc_move)
  - [clc\_move\_nodelta](#clc_move_nodelta)
  - [clc\_move\_batched](#clc_move_batched)
  - [clc\_userinfo](#clc_userinfo)
  - [clc\_userinfo\_delta](#clc_userinfo_delta)
  - [clc\_stringcmd](#clc_stringcmd)
  - [clc\_setting](#clc_setting)
  - [clc\_nop](#clc_nop)
- [Delta Encoding](#delta-encoding)
  - [Entity State (U\_ Flags)](#entity-state-u_-flags)
  - [Player State (PS\_ and EPS\_ Flags)](#player-state-ps_-and-eps_-flags)
  - [User Commands (CM\_ Flags)](#user-commands-cm_-flags)
- [Configstring Layout](#configstring-layout)
  - [Standard Limits (Protocol 34)](#standard-limits-protocol-34)
  - [Extended Limits](#extended-limits)
- [Client and Server Settings](#client-and-server-settings)
  - [Client Settings](#client-settings)
  - [Server Settings](#server-settings)
- [Frame Flags](#frame-flags)
- [Sound Encoding](#sound-encoding)
- [Coordinate and Angle Quantization](#coordinate-and-angle-quantization)

# About

This document describes the network protocol used by Q2PRO, based on the
original Quake 2 network protocol (version 34) and its enhanced variants
(R1Q2 protocol 35, Q2PRO protocol 36, MVD protocol 37, and AQtion
protocol 38). The primary source of truth is `inc/common/protocol.h` and
the surrounding implementation in the `src/common/net/`, `src/server/`,
and `src/client/` directories.

All multi-byte integers in the wire format are little-endian unless
otherwise noted. Field sizes are given as: byte (8-bit), short (16-bit),
long (32-bit), string (NUL-terminated).

# Protocol Versions

## Major Versions

The major protocol version is sent in the `connect` command and in the
`svc_serverdata` message. Supported values:

| Value | Constant                      | Description                              |
|-------|-------------------------------|------------------------------------------|
| 26    | `PROTOCOL_VERSION_OLD`        | Quake 2 pre-3.19 (rejected by server)   |
| 34    | `PROTOCOL_VERSION_DEFAULT`    | Standard Quake 2 protocol (3.19+)       |
| 35    | `PROTOCOL_VERSION_R1Q2`       | R1Q2 enhanced protocol                  |
| 36    | `PROTOCOL_VERSION_Q2PRO`      | Q2PRO enhanced protocol                 |
| 37    | `PROTOCOL_VERSION_MVD`        | MVD stream protocol (not used for UDP)  |
| 38    | `PROTOCOL_VERSION_AQTION`     | AQtion enhanced protocol                |

Clients with protocol version below 34 are rejected with a version
error. The server advertises all supported protocols in its challenge
response so the client can negotiate the highest mutually supported
version.

## Minor Versions

Enhanced protocols (35, 36, 38) have an additional minor version number
negotiated during connection. The minor version enables incremental
feature additions within the same major protocol.

**R1Q2 (protocol 35) minor versions:**

| Value | Constant                            | Feature                |
|-------|-------------------------------------|------------------------|
| 1903  | `PROTOCOL_VERSION_R1Q2_MINIMUM`     | Minimum supported      |
| 1904  | `PROTOCOL_VERSION_R1Q2_UCMD`        | Enhanced usercmd       |
| 1905  | `PROTOCOL_VERSION_R1Q2_LONG_SOLID`  | 32-bit solid encoding  |

**Q2PRO (protocol 36) minor versions:**

| Value | Constant                                  | Feature                    |
|-------|-------------------------------------------|----------------------------|
| 1015  | `PROTOCOL_VERSION_Q2PRO_MINIMUM`          | Minimum supported          |
| 1016  | `PROTOCOL_VERSION_Q2PRO_RESERVED`         | Reserved (never used)      |
| 1017  | `PROTOCOL_VERSION_Q2PRO_BEAM_ORIGIN`      | Beam origin encoding       |
| 1018  | `PROTOCOL_VERSION_Q2PRO_SHORT_ANGLES`     | Short angle encoding       |
| 1019  | `PROTOCOL_VERSION_Q2PRO_SERVER_STATE`     | Server state in serverdata |
| 1020  | `PROTOCOL_VERSION_Q2PRO_EXTENDED_LAYOUT`  | Extended layout strings    |
| 1021  | `PROTOCOL_VERSION_Q2PRO_ZLIB_DOWNLOADS`   | Zlib compressed downloads  |
| 1022  | `PROTOCOL_VERSION_Q2PRO_CLIENTNUM_SHORT`  | 16-bit client numbers      |
| 1023  | `PROTOCOL_VERSION_Q2PRO_CINEMATICS`       | Cinematic server state     |
| 1024  | `PROTOCOL_VERSION_Q2PRO_EXTENDED_LIMITS`  | Extended limits (pflags)   |
| 1025  | `PROTOCOL_VERSION_Q2PRO_EXTENDED_LIMITS_2`| Extended limits v2         |
| 1026  | `PROTOCOL_VERSION_Q2PRO_PLAYERFOG`        | Player fog support         |

**AQtion (protocol 38) minor versions:**

| Value | Constant                                  | Feature                      |
|-------|-------------------------------------------|------------------------------|
| 3011  | `PROTOCOL_VERSION_AQTION_MINIMUM`         | Minimum (≈ Q2PRO zlib DL)   |
| 3012  | `PROTOCOL_VERSION_AQTION_GHUD`            | Game DLL HUD elements        |
| 3013  | `PROTOCOL_VERSION_AQTION_CVARSYNC`        | Cvar synchronization         |
| 3014  | `PROTOCOL_VERSION_AQTION_GHUD2`           | Game DLL HUD v2              |
| 3015  | `PROTOCOL_VERSION_AQTION_CLIENTNUM_SHORT` | 16-bit client numbers        |
| 3016  | `PROTOCOL_VERSION_AQTION_CINEMATICS`      | Cinematic server state       |
| 3017  | `PROTOCOL_VERSION_AQTION_EXTENDED_LIMITS` | Extended limits (pflags)     |

## Extended Protocol Versions

When the server uses extended configstring/entity limits (`csr.extended`
is true), an additional "extended" version is reported in the serverinfo
`protocol` key as `"36"`. These versions define the extended feature
level:

| Value | Constant                                  | Feature               |
|-------|-------------------------------------------|-----------------------|
| 3434  | `PROTOCOL_VERSION_EXTENDED_MINIMUM`       | Extended limits       |
| 3435  | `PROTOCOL_VERSION_EXTENDED_LIMITS_2`      | Extended limits v2    |
| 3436  | `PROTOCOL_VERSION_EXTENDED_PLAYERFOG`     | Player fog            |

Extended protocol requires Q2PRO protocol 36 with a sufficiently high
minor version (≥ 1024), or AQtion protocol 38 with minor version ≥ 3017.

# Connection Handshake

## Out-of-Band Packets

Connectionless (out-of-band) packets are identified by a 4-byte header
of `0xFFFFFFFF` (-1 as a signed 32-bit integer). The payload is a
text string parsed as a command line. These packets bypass the netchan
sequencing layer entirely.

```
[4 bytes: 0xFF 0xFF 0xFF 0xFF] [string: command line]
```

## Challenge Request

The client initiates the connection by sending a `getchallenge` OOB
packet to the server:

```
Client → Server:  getchallenge\n
```

## Challenge Response

The server allocates a random challenge number and responds with the
supported protocol versions:

```
Server → Client:  challenge <challenge_number> p=34,35,36,38
```

The `p=` parameter lists the major protocol versions supported by the
server, comma-separated. The client selects the highest mutually
supported version based on the `cl_protocol` cvar and this list.

## Connect Request

The client sends a `connect` command with protocol-dependent parameters:

```
Client → Server:  connect <protocol> <qport> <challenge> "<userinfo>" [extended params...]
```

**Common fields (all protocols):**

| Position | Field       | Description                                 |
|----------|-------------|---------------------------------------------|
| Argv(1)  | protocol    | Major protocol version (34, 35, 36, or 38)  |
| Argv(2)  | qport       | Client port for NAT disambiguation           |
| Argv(3)  | challenge   | Challenge number from server                 |
| Argv(4)  | userinfo    | Quoted key/value userinfo string             |

**Protocol 34 (default):** No additional parameters.

**Protocol 35 (R1Q2):**

| Position | Field       | Description                                   |
|----------|-------------|-----------------------------------------------|
| Argv(5)  | maxmsglen   | Maximum packet length (0 = max available)      |
| Argv(6)  | version     | Minor R1Q2 protocol version                    |

**Protocol 36 (Q2PRO) and 38 (AQtion):**

| Position | Field       | Description                                    |
|----------|-------------|------------------------------------------------|
| Argv(5)  | maxmsglen   | Maximum packet length (0 = max available)       |
| Argv(6)  | nctype      | Netchan type: 0 = old, 1 = new                  |
| Argv(7)  | zlib        | Zlib support: 0 = no, 1 = yes                   |
| Argv(8)  | version     | Minor protocol version                           |

Packet length limits:

- **Minimum:** 512 bytes (`MIN_PACKETLEN`)
- **Maximum:** 4086 bytes (`MAX_PACKETLEN_WRITABLE`)
- **Default:** 1390 bytes (`MAX_PACKETLEN_WRITABLE_DEFAULT`)

## Connect Response

If the server accepts the connection, it responds:

```
Server → Client:  client_connect [nc=<0|1>] [ac=<n>] [dlserver=<url>] [map=<name>]
```

| Parameter  | Description                                            |
|------------|--------------------------------------------------------|
| `nc=`      | Netchan type override (Q2PRO/AQtion only)              |
| `ac=`      | Anticheat requirement level                            |
| `dlserver=`| HTTP download server URL                               |
| `map=`     | Current map name (for levelshot loading screen)        |

On rejection, the server sends `print\n<reason>` instead.

## Entering the Game

After the `client_connect` response:

1. Client sets up the netchan and sends `new` as a reliable string
   command.
2. Server responds with:
   - `svc_serverdata` — protocol version, map info, client slot
   - Configstrings (via `svc_configstring`, `svc_configstringstream`,
     or `svc_gamestate`)
   - Entity baselines (via `svc_spawnbaseline`, `svc_baselinestream`,
     or embedded in `svc_gamestate`)
3. Client sends `begin <spawncount>` when precaching is complete.
4. Server starts sending `svc_frame` updates.

## Other Connectionless Packets

| Command    | Direction        | Description                         |
|------------|------------------|-------------------------------------|
| `ping`     | Any → Server     | Server replies with `ack`           |
| `ack`      | Server → Client  | Ping acknowledgement                |
| `status`   | Any → Server     | Server info and player list         |
| `info`     | Server → Client  | Server browser info response        |
| `rcon`     | Client → Server  | Remote console command              |
| `print`    | Server → Client  | Print a message (connection errors) |

# Netchan Layer

The netchan provides sequenced, optionally reliable datagram delivery
over UDP. There are two variants: the original "old" netchan used by
protocol 34 and R1Q2, and the "new" netchan introduced by Q2PRO.

Common constants:

- **MAX_PACKETLEN:** 4096 bytes (maximum single UDP payload)
- **PACKET_HEADER:** 10 bytes (worst case: two longs + one short)
- **MAX_MSGLEN:** 32768 bytes (32 KiB, maximum logical message size)

## Old Netchan (NETCHAN\_OLD)

Used by protocol 34 and optionally by R1Q2/Q2PRO. Packet header format:

```
[long]  sequence:    bits 0-30 = sequence number, bit 31 = reliable flag
[long]  ack:         bits 0-30 = ack sequence,    bit 31 = reliable ack flag
[short] qport        (protocol 34 client→server only)
[byte]  qport        (protocol 35+ client→server, if qport != 0)
[...]   payload      (reliable data first, then unreliable)
```

- **Sequence space:** 31 bits (0 to 2^31 - 1)
- No fragmentation support — if a message exceeds `maxpacketlen`, the
  unreliable portion is dropped.
- Reliable data is prepended to the packet. If the remote side has not
  acknowledged the last reliable message, it is retransmitted.

## New Netchan (NETCHAN\_NEW)

Default for Q2PRO (protocol 36) and AQtion (protocol 38). Adds message
fragmentation. Packet header format:

```
[long]  sequence:    bits 0-29 = sequence number, bit 30 = fragment flag, bit 31 = reliable flag
[long]  ack:         bits 0-29 = ack sequence,    bit 31 = reliable ack flag
[byte]  qport        (client→server only, if qport != 0)
[short] fragment     (only if fragment flag is set: bits 0-14 = offset, bit 15 = more_fragments)
[...]   payload
```

- **Sequence space:** 30 bits (0 to 2^30 - 1)
- Messages larger than `maxpacketlen` are automatically fragmented and
  reassembled.
- Fragment offset is byte-granular with a 15-bit range (max 32767 bytes,
  within MAX_MSGLEN).

## Reliable Message Delivery

Both netchan types use a single-bit alternating reliable sequence:

1. Sender copies the reliable message buffer into a transmit buffer and
   flips its `reliable_sequence` bit.
2. Each packet carries the current reliable sequence bit in the sequence
   word.
3. The receiver acknowledges by echoing the bit in the ack word.
4. If the sender sees that `incoming_reliable_acknowledged` differs from
   `reliable_sequence`, it retransmits the reliable buffer.

Only one reliable message can be in flight at a time. Reliable data is
always placed before unreliable data in the packet.

## Fragmentation

Only available with `NETCHAN_NEW`. When a packet (reliable + unreliable)
exceeds `maxpacketlen`:

1. The combined data is written to the fragment output buffer.
2. Fragments of up to `maxpacketlen` bytes are sent, each with a
   fragment header containing the byte offset and a "more fragments"
   flag.
3. The receiver reassembles fragments sequentially; out-of-order or
   missing fragments cause the whole message to be dropped.
4. The sequence number advances only after the final fragment is sent.

## Qport

The `qport` field works around NAT routers that remap client source
ports mid-session. If the base IP address and qport match, the channel
is considered valid even if the UDP source port has changed.

- **Protocol 34:** 16-bit qport sent by client in every packet.
- **Protocol 35+:** 8-bit qport sent only if non-zero.

# Server-to-Client Messages

Server messages are identified by their opcode byte. In enhanced
protocols (35+), the top 3 bits of the first byte in a frame message
may encode extra flags (see `SVCMD_BITS`/`SVCMD_MASK`).

Full opcode table (`svc_ops_t`):

| Value | Name                      | Description                         |
|-------|---------------------------|-------------------------------------|
| 0     | `svc_bad`                 | Invalid                             |
| 1     | `svc_muzzleflash`         | Muzzle flash effect                 |
| 2     | `svc_muzzleflash2`        | Monster muzzle flash                |
| 3     | `svc_temp_entity`         | Temporary entity effect             |
| 4     | `svc_layout`              | HUD layout string                   |
| 5     | `svc_inventory`           | Inventory data                      |
| 6     | `svc_nop`                 | No operation                        |
| 7     | `svc_disconnect`          | Server disconnect                   |
| 8     | `svc_reconnect`           | Force reconnect                     |
| 9     | `svc_sound`               | Sound effect                        |
| 10    | `svc_print`               | Print to console                    |
| 11    | `svc_stufftext`           | Stuff into client command buffer    |
| 12    | `svc_serverdata`          | Server initialization data          |
| 13    | `svc_configstring`        | Set a configstring                  |
| 14    | `svc_spawnbaseline`       | Entity baseline                     |
| 15    | `svc_centerprint`         | Centered screen text                |
| 16    | `svc_download`            | File download chunk                 |
| 17    | `svc_playerinfo`          | Player state delta                  |
| 18    | `svc_packetentities`      | Entity state deltas                 |
| 19    | `svc_deltapacketentities` | Delta packet entities (unused)      |
| 20    | `svc_frame`               | Frame update                        |
| 21    | `svc_zpacket`             | Zlib compressed packet (R1Q2+)     |
| 22    | `svc_zdownload`           | Zlib compressed download (R1Q2+)   |
| 23    | `svc_gamestate`           | Full gamestate (Q2PRO)             |
| 24    | `svc_setting`             | Server setting (R1Q2+)             |
| 25    | `svc_configstringstream`  | Streamed configstrings (Q2PRO)     |
| 26    | `svc_baselinestream`      | Streamed baselines (Q2PRO)         |
| 29    | `svc_ghudupdate`          | Game HUD update (AQtion)           |
| 30    | `svc_extend`              | Extension message (AQtion)         |
| 31    | `svc_userstatistic`       | User statistics (AQtion)           |
| 32    | `svc_cvarsync`            | Cvar sync (AQtion)                 |

## svc\_serverdata

Sent as the first reliable message after a client sends `new`. Contains
all information needed to initialize the client's game state.

**Wire format (common to all protocols):**

```
[byte]   svc_serverdata (12)
[long]   protocol          — major protocol version
[long]   spawncount        — server map instance identifier
[byte]   attractloop       — always 0 (demo attract loop, unused)
[string] gamedir           — game directory name
[short]  clientnum         — client entity number (-1 for cinematic)
[string] levelname         — map display name
```

**Protocol 35 (R1Q2) appends:**

```
[byte]   enhanced          — always 0
[short]  version           — minor R1Q2 protocol version
[byte]   advanced_deltas   — always 0 (unused)
[byte]   strafejump_hack   — strafejump hack enabled
```

**Protocol 36 (Q2PRO) appends:**

```
[short]  version           — minor Q2PRO protocol version
[byte]   server_state      — server state enum (version ≥ 1019)
```

Then, depending on minor version:

*If version ≥ 1024 (`PROTOCOL_VERSION_Q2PRO_EXTENDED_LIMITS`):*

```
[short]  pflags            — protocol flags bitmask (see below)
```

*If version < 1024:*

```
[byte]   strafejump_hack
[byte]   qw_mode
[byte]   waterjump_hack
```

**Protocol 38 (AQtion) appends:**

```
[short]  version           — minor AQtion protocol version
[byte]   server_state      — server state enum
```

Then, depending on minor version:

*If version ≥ 3017 (`PROTOCOL_VERSION_AQTION_EXTENDED_LIMITS`):*

```
[short]  pflags            — protocol flags bitmask (see below)
```

*If version < 3017:*

```
[byte]   strafejump_hack
[byte]   qw_mode
[byte]   waterjump_hack
```

**Protocol flags (`pflags`) bitmask:**

| Bit | Constant                  | Description                   |
|-----|---------------------------|-------------------------------|
| 0   | `Q2PRO_PF_STRAFEJUMP_HACK` | Strafejump hack enabled     |
| 1   | `Q2PRO_PF_QW_MODE`         | QuakeWorld movement mode    |
| 2   | `Q2PRO_PF_WATERJUMP_HACK`  | Waterjump hack enabled      |
| 3   | `Q2PRO_PF_EXTENSIONS`      | Extended configstring limits|
| 4   | `Q2PRO_PF_EXTENSIONS_2`    | Extended limits v2          |

## svc\_frame (Protocol 34)

The default frame format used by protocol 34. Sent each server frame to
update the client's world state.

```
[byte]   svc_frame (20)
[long]   framenum          — server frame number
[long]   deltaframe        — frame number being delta'd from (-1 = none)
[byte]   suppress_count    — number of rate-dropped packets
[byte]   areabytes         — size of area bits
[n bytes] areabits         — PVS area visibility data
[byte]   svc_playerinfo (17)
[...]    player state delta (see Delta Encoding)
[byte]   svc_packetentities (18)
[...]    entity state deltas (see Delta Encoding)
```

## svc\_frame (Enhanced Protocols)

Protocols 35, 36, and 38 use a compact frame encoding that packs
additional information into the opcode byte and a flags byte.

```
[byte]   svc_frame | (extraflags_high << 1)
         — bits 0-4: svc_frame opcode (20)
         — bits 5-7: extraflags bits 4-6
[long]   framenum_and_delta
         — bits 0-26: frame number (FRAMENUM_BITS)
         — bits 27-31: delta offset (0-30; 31 = no delta)
[byte]   suppress_and_extraflags
         — bits 0-3: suppress count (SUPPRESSCOUNT_BITS)
         — bits 4-7: extraflags bits 0-3
[byte]   areabytes
[n bytes] areabits
[...]    player state delta (no svc_playerinfo prefix in Q2PRO)
[...]    entity state deltas
```

The `extraflags` carry the `EPS_*` bits for the player state delta (see
Delta Encoding section).

For Q2PRO protocol 36, the `svc_packetentities` opcode is omitted — 
entity data follows the player state directly. For AQtion protocol 38,
the `svc_playerinfo` and `svc_packetentities` opcodes are written
explicitly.

## svc\_playerinfo

Player state delta encoding. Wire format depends on the protocol:

- **Protocol 34:** Standard `PS_*` bitmask + field encoding (see Delta
  Encoding).
- **Protocol 35+ (Enhanced):** `PS_*` bitmask with additional `EPS_*`
  bits carried out-of-band in the frame header's `extraflags`.
- **Q2PRO/AQtion with `EPS_CLIENTNUM`:** The client entity number is
  appended after the player state, encoded as byte (old versions) or
  short (version ≥ 1022/3015+).

## svc\_packetentities

A sequence of delta-encoded entity states. Each entity is encoded as:

```
[variable] entity bitmask and number (see U_ flags in Delta Encoding)
[variable] changed fields
```

The list is terminated by a short value of `0` (entity number 0 with
no flags set).

## svc\_spawnbaseline

A single entity baseline (initial state for delta encoding), used
during the game state transfer:

```
[byte]   svc_spawnbaseline (14)
[...]    delta-encoded entity (forced write, delta from NULL)
```

## svc\_configstring

Sets a single configstring by index:

```
[byte]   svc_configstring (13)
[short]  index
[string] value (NUL-terminated)
```

## svc\_configstringstream

Q2PRO streaming configstring transfer. Multiple configstrings packed
into each message:

```
[byte]   svc_configstringstream (25)
{ [short] index  [string] value }*   — repeated entries
[short]  end_index                    — index == csr->end terminates the stream
```

When the buffer fills, the stream is flushed and a new
`svc_configstringstream` opcode begins the next packet.

## svc\_baselinestream

Q2PRO streaming baseline transfer:

```
[byte]   svc_baselinestream (26)
{ [entity delta] }*                 — repeated entity baselines
[short]  0                           — terminates the stream
```

## svc\_gamestate

Q2PRO combined gamestate message containing all configstrings and
baselines in a single logical message (may be fragmented by netchan):

```
[byte]   svc_gamestate (23)
{ [short] index  [string] value }*  — configstrings
[short]  end_index                   — end of configstrings
{ [entity delta] }*                 — baselines
[short]  0                           — end of baselines
```

## svc\_sound

```
[byte]   svc_sound (9)
[byte]   flags                       — SND_* bitmask
[byte]   sound_index                 — (or [short] if SND_INDEX16)
[byte]   volume                      — if SND_VOLUME
[byte]   attenuation                 — if SND_ATTENUATION
[byte]   offset                      — if SND_OFFSET (msec from frame start)
[short]  entity_channel              — if SND_ENT (bits 0-2: channel, 3-15: entity)
[3 shorts] position                  — if SND_POS (fixed-point coordinates)
```

## svc\_print

```
[byte]   svc_print (10)
[byte]   level                       — PRINT_LOW, PRINT_MEDIUM, PRINT_HIGH, PRINT_CHAT
[string] text
```

## svc\_stufftext

```
[byte]   svc_stufftext (11)
[string] command                     — newline-terminated command string
```

## svc\_centerprint

```
[byte]   svc_centerprint (15)
[string] text
```

## svc\_download

```
[byte]   svc_download (16)
[short]  size                        — chunk size (-1 = error)
[byte]   percent                     — download progress
[n bytes] data                       — file data chunk
```

## svc\_zpacket

Zlib-compressed container for other server messages (R1Q2+, requires
zlib support):

```
[byte]   svc_zpacket (21)
[short]  compressed_length
[short]  uncompressed_length
[n bytes] compressed_data            — zlib deflate stream
```

## svc\_zdownload

Zlib-compressed download chunk (R1Q2+):

```
[byte]   svc_zdownload (22)
[short]  compressed_length
[short]  uncompressed_length
[n bytes] compressed_data
```

## svc\_muzzleflash / svc\_muzzleflash2

```
[byte]   svc_muzzleflash (1) or svc_muzzleflash2 (2)
[short]  entity
[byte]   effect_id
```

## svc\_temp\_entity

```
[byte]   svc_temp_entity (3)
[byte]   type
[...]    type-dependent data
```

## svc\_layout

```
[byte]   svc_layout (4)
[string] layout_string
```

## svc\_inventory

```
[byte]   svc_inventory (5)
[256 shorts] item counts             — MAX_ITEMS entries
```

## svc\_setting

Server-to-client setting notification (R1Q2+):

```
[byte]   svc_setting (24)
[long]   index                       — serverSetting_t enum value
[long]   value
```

## svc\_reconnect / svc\_disconnect / svc\_nop

Simple single-byte messages with no payload:

```
[byte]   svc_reconnect (8) | svc_disconnect (7) | svc_nop (6)
```

# Client-to-Server Messages

Client message opcodes (`clc_ops_t`):

| Value | Name                | Description                        |
|-------|---------------------|------------------------------------|
| 0     | `clc_bad`           | Invalid                            |
| 1     | `clc_nop`           | No operation / keepalive           |
| 2     | `clc_move`          | Movement commands                  |
| 3     | `clc_userinfo`      | Full userinfo string               |
| 4     | `clc_stringcmd`     | Arbitrary string command           |
| 5     | `clc_setting`       | Client setting (R1Q2+)            |
| 10    | `clc_move_nodelta`  | Movement, no delta (Q2PRO)        |
| 11    | `clc_move_batched`  | Batched movement (Q2PRO)          |
| 12    | `clc_userinfo_delta`| Delta userinfo update (Q2PRO)     |
| 50    | `clc_cvarsync`      | Cvar sync (AQtion)                |

## clc\_move

Standard movement command packet. Contains three usercmds (oldest, old,
new) delta-encoded against each other:

**Protocol 34:**

```
[byte]   clc_move (2)
[byte]   checksum                     — packet checksum (protocol 34 only)
[long]   lastframe                    — last received server frame
[...]    usercmd oldest               — delta from NULL
[...]    usercmd old                  — delta from oldest
[...]    usercmd new                  — delta from old
```

**Protocol 35+ (R1Q2 with version ≥ 1904):**

Uses `MSG_ReadDeltaUsercmd_Hacked` encoding with button byte packing.

**Protocol 36+ (Q2PRO/AQtion):**

No checksum byte. Uses standard delta encoding.

Each usercmd is delta-encoded using `CM_*` flags:

```
[byte]   bits                         — CM_* bitmask
[byte]   msec                         — always sent
[byte]   lightlevel                   — always sent
[short]  angles[0]                    — if CM_ANGLE1
[short]  angles[1]                    — if CM_ANGLE2
[short]  angles[2]                    — if CM_ANGLE3
[short]  forwardmove                  — if CM_FORWARD
[short]  sidemove                     — if CM_SIDE
[short]  upmove                       — if CM_UP
[byte]   buttons                      — if CM_BUTTONS
[byte]   impulse                      — if CM_IMPULSE
```

## clc\_move\_nodelta

Q2PRO-specific. Same as `clc_move` but indicates the client has no
delta reference frame (e.g., first frame after loading):

```
[byte]   clc_move_nodelta (10)
[long]   lastframe                    — always -1
[...]    usercmds (same as clc_move)
```

## clc\_move\_batched

Q2PRO-specific. Multiple movement commands batched into one packet:

```
[byte]   clc_move_batched (11)
[long]   lastframe
[byte]   count                        — number of additional cmd sets
[...]    usercmds
```

## clc\_userinfo

Full userinfo string replacement:

```
[byte]   clc_userinfo (3)
[string] userinfo
```

## clc\_userinfo\_delta

Q2PRO-specific incremental userinfo update:

```
[byte]   clc_userinfo_delta (12)
[string] key/value delta
```

## clc\_stringcmd

Arbitrary string command (e.g., `new`, `begin`, `say`, `download`):

```
[byte]   clc_stringcmd (4)
[string] command
```

## clc\_setting

Client setting notification (R1Q2+):

```
[byte]   clc_setting (5)
[short]  index                        — clientSetting_t enum value
[short]  value
```

## clc\_nop

Keepalive / no-op, no payload:

```
[byte]   clc_nop (1)
```

# Delta Encoding

Delta encoding transmits only the fields that have changed relative to
a previous state. A bitmask indicates which fields are present.

## Entity State (U\_ Flags)

Entity state updates use a variable-length bitmask of 1 to 5 bytes.
Each byte's MSB (`U_MOREBITS1` through `U_MOREBITS4`) indicates whether
another byte of flags follows.

**First byte (bits 0-7):**

| Bit | Flag           | Description                            |
|-----|----------------|----------------------------------------|
| 0   | `U_ORIGIN1`    | X origin changed                       |
| 1   | `U_ORIGIN2`    | Y origin changed                       |
| 2   | `U_ANGLE2`     | Yaw changed                            |
| 3   | `U_ANGLE3`     | Roll changed                           |
| 4   | `U_FRAME8`     | Frame as byte                          |
| 5   | `U_EVENT`      | Entity event                           |
| 6   | `U_REMOVE`     | Remove this entity                     |
| 7   | `U_MOREBITS1`  | Read one additional byte               |

**Second byte (bits 8-15):**

| Bit | Flag           | Description                            |
|-----|----------------|----------------------------------------|
| 8   | `U_NUMBER16`   | Entity number is 16-bit (else 8-bit)  |
| 9   | `U_ORIGIN3`    | Z origin changed                       |
| 10  | `U_ANGLE1`     | Pitch changed                          |
| 11  | `U_MODEL`      | Model index changed                    |
| 12  | `U_RENDERFX8`  | Render effects as byte                 |
| 13  | `U_ANGLE16`    | Angles encoded as 16-bit shorts       |
| 14  | `U_EFFECTS8`   | Effects as byte                        |
| 15  | `U_MOREBITS2`  | Read one additional byte               |

**Third byte (bits 16-23):**

| Bit | Flag           | Description                            |
|-----|----------------|----------------------------------------|
| 16  | `U_SKIN8`      | Skin as byte                           |
| 17  | `U_FRAME16`    | Frame as short                         |
| 18  | `U_RENDERFX16` | Render effects as short (8+16 = 32)   |
| 19  | `U_EFFECTS16`  | Effects as short (8+16 = 32)          |
| 20  | `U_MODEL2`     | Secondary model (weapons, flags)       |
| 21  | `U_MODEL3`     | Tertiary model                         |
| 22  | `U_MODEL4`     | Quaternary model                       |
| 23  | `U_MOREBITS3`  | Read one additional byte               |

**Fourth byte (bits 24-31):**

| Bit | Flag           | Description                            |
|-----|----------------|----------------------------------------|
| 24  | `U_OLDORIGIN`  | Old origin for lerp                    |
| 25  | `U_SKIN16`     | Skin as short (8+16 = 32-bit)         |
| 26  | `U_SOUND`      | Looping sound index                    |
| 27  | `U_SOLID`      | Solid bounds encoding                  |
| 28  | `U_MODEL16`    | Model index as 16-bit                  |
| 29  | `U_MOREFX8`    | More effects byte (extended)           |
| 30  | `U_ALPHA`      | Entity alpha/transparency              |
| 31  | `U_MOREBITS4`  | Read one additional byte               |

**Fifth byte (bits 32-39, extended protocols only):**

| Bit | Flag           | Description                            |
|-----|----------------|----------------------------------------|
| 32  | `U_SCALE`      | Entity scale                           |
| 33  | `U_MOREFX16`   | More effects as short (8+16 = 32)     |

**Compound flags:**

- `U_SKIN32` = `U_SKIN8 | U_SKIN16` — 32-bit skin (used for laser colors)
- `U_EFFECTS32` = `U_EFFECTS8 | U_EFFECTS16` — 32-bit effects
- `U_RENDERFX32` = `U_RENDERFX8 | U_RENDERFX16` — 32-bit render effects
- `U_MOREFX32` = `U_MOREFX8 | U_MOREFX16` — 32-bit more effects

Entity number encoding: After the flag bytes, the entity number follows
as either a byte (default) or a short (if `U_NUMBER16` is set).

## Player State (PS\_ and EPS\_ Flags)

Player state is delta-encoded with a 16-bit `PS_*` bitmask (with an
optional `PS_MOREBITS` extension byte):

| Bit  | Flag              | Field                              |
|------|-------------------|------------------------------------|
| 0    | `PS_M_TYPE`       | Move type (`pm_type`)              |
| 1    | `PS_M_ORIGIN`     | Position origin                    |
| 2    | `PS_M_VELOCITY`   | Velocity                           |
| 3    | `PS_M_TIME`       | Move time                          |
| 4    | `PS_M_FLAGS`      | Pmove flags                        |
| 5    | `PS_M_GRAVITY`    | Gravity                            |
| 6    | `PS_M_DELTA_ANGLES` | Delta angles                     |
| 7    | `PS_VIEWOFFSET`   | View height offset                 |
| 8    | `PS_VIEWANGLES`   | View angles                        |
| 9    | `PS_KICKANGLES`   | Kick angles (damage/recoil)        |
| 10   | `PS_BLEND`        | Screen color blend                 |
| 11   | `PS_FOV`          | Field of view                      |
| 12   | `PS_WEAPONINDEX`  | Current weapon model               |
| 13   | `PS_WEAPONFRAME`  | Weapon animation frame             |
| 14   | `PS_RDFLAGS`      | Render flags                       |
| 15   | `PS_MOREBITS`     | Read one additional byte           |
| 16   | `PS_FOG`          | Fog parameters (extended)          |

**R1Q2/Q2PRO extra player state flags** (carried in the frame header's
`extraflags`, not in the player state bitmask):

| Bit | Flag              | Field                              |
|-----|-------------------|------------------------------------|
| 0   | `EPS_GUNOFFSET`   | Gun view offset                    |
| 1   | `EPS_GUNANGLES`   | Gun view angles                    |
| 2   | `EPS_M_VELOCITY2` | High bits of velocity              |
| 3   | `EPS_M_ORIGIN2`   | High bits of origin                |
| 4   | `EPS_VIEWANGLE2`  | High bits of view angles           |
| 5   | `EPS_STATS`       | Player stats changed               |
| 6   | `EPS_CLIENTNUM`   | Client number (Q2PRO/AQtion only)  |

**Fog encoding** (when `PS_FOG` is set, extended protocols only):

A byte of `fog_bits_t` flags controls which fog parameters follow:

| Bit | Flag                         | Fields                          |
|-----|------------------------------|---------------------------------|
| 0   | `FOG_BIT_COLOR`              | Fog color (3 bytes RGB)         |
| 1   | `FOG_BIT_DENSITY`            | Fog density (short)             |
| 2   | `FOG_BIT_HEIGHT_DENSITY`     | Height fog density              |
| 3   | `FOG_BIT_HEIGHT_FALLOFF`     | Height fog falloff              |
| 4   | `FOG_BIT_HEIGHT_START_COLOR` | Height start color (3 bytes)    |
| 5   | `FOG_BIT_HEIGHT_END_COLOR`   | Height end color (3 bytes)      |
| 6   | `FOG_BIT_HEIGHT_START_DIST`  | Height start distance (short)   |
| 7   | `FOG_BIT_HEIGHT_END_DIST`    | Height end distance (short)     |

## User Commands (CM\_ Flags)

| Bit | Flag         | Field                          |
|-----|--------------|--------------------------------|
| 0   | `CM_ANGLE1`  | Pitch angle                    |
| 1   | `CM_ANGLE2`  | Yaw angle                      |
| 2   | `CM_ANGLE3`  | Roll angle                     |
| 3   | `CM_FORWARD` | Forward move                   |
| 4   | `CM_SIDE`    | Side move                      |
| 5   | `CM_UP`      | Up move                        |
| 6   | `CM_BUTTONS` | Buttons                        |
| 7   | `CM_IMPULSE` | Impulse                        |

`msec` and `lightlevel` are always transmitted (not flagged).

**R1Q2 button byte hacks:** When using R1Q2 protocol with version ≥
1904, the button byte is repurposed to carry compact movement data:

| Bit | Constant         | Description                        |
|-----|------------------|------------------------------------|
| 0-1 | `BUTTON_MASK`   | Standard button bits (attack, use) |
| 2   | `BUTTON_FORWARD` | Forward move changed               |
| 3   | `BUTTON_SIDE`    | Side move changed                  |
| 4   | `BUTTON_UP`      | Up move changed                    |
| 5   | `BUTTON_ANGLE1`  | Pitch angle changed                |
| 6   | `BUTTON_ANGLE2`  | Yaw angle changed                  |

# Configstring Layout

Configstrings are a general mechanism for the server to communicate
named resource indices and other data to all clients. Each configstring
can be at most `MAX_QPATH` (64) characters.

## Standard Limits (Protocol 34)

| Index | Constant              | Count | Description              |
|-------|-----------------------|-------|--------------------------|
| 0     | `CS_NAME`             | 1     | Map display name         |
| 1     | `CS_CDTRACK`          | 1     | CD music track           |
| 2     | `CS_SKY`              | 1     | Sky texture name         |
| 3     | `CS_SKYAXIS`          | 1     | Sky rotation axis        |
| 4     | `CS_SKYROTATE`        | 1     | Sky rotation speed       |
| 5     | `CS_STATUSBAR`        | 24    | HUD layout program       |
| 29    | `CS_AIRACCEL_OLD`     | 1     | Air acceleration control |
| 30    | `CS_MAXCLIENTS_OLD`   | 1     | Max client count         |
| 31    | `CS_MAPCHECKSUM_OLD`  | 1     | Map checksum (anti-cheat)|
| 32    | `CS_MODELS_OLD`       | 256   | Model paths              |
| 288   | `CS_SOUNDS_OLD`       | 256   | Sound paths              |
| 544   | `CS_IMAGES_OLD`       | 256   | Image paths              |
| 800   | `CS_LIGHTS_OLD`       | 256   | Lightstyle strings       |
| 1056  | `CS_ITEMS_OLD`        | 256   | Item names               |
| 1312  | `CS_PLAYERSKINS_OLD`  | 256   | Player skin strings      |
| 1568  | `CS_GENERAL_OLD`      | 512   | General strings          |

**Total:** 2080 configstrings (`MAX_CONFIGSTRINGS_OLD`)

**Standard entity/resource limits:**

| Limit            | Value |
|------------------|-------|
| `MAX_EDICTS_OLD` | 1024  |
| `MAX_MODELS_OLD` | 256   |
| `MAX_SOUNDS_OLD` | 256   |
| `MAX_IMAGES_OLD` | 256   |
| `MAX_CLIENTS`    | 256   |
| `MAX_LIGHTSTYLES`| 256   |
| `MAX_ITEMS`      | 256   |

## Extended Limits

When `Q2PRO_PF_EXTENSIONS` is set in the protocol flags, the extended
configstring layout (`cs_remap_new`) is used with significantly higher
limits:

| Index | Constant          | Count | Description              |
|-------|-------------------|-------|--------------------------|
| 0-58  | (same as standard)| —     | Fixed indices preserved  |
| 59    | `CS_AIRACCEL`     | 1     | Air acceleration control |
| 60    | `CS_MAXCLIENTS`   | 1     | Max client count         |
| 61    | `CS_MAPCHECKSUM`  | 1     | Map checksum             |
| 62    | `CS_MODELS`       | 8192  | Model paths              |
| 8254  | `CS_SOUNDS`       | 2048  | Sound paths              |
| 10302 | `CS_IMAGES`       | 2048  | Image paths              |
| 12350 | `CS_LIGHTS`       | 256   | Lightstyle strings       |
| 12606 | `CS_ITEMS`        | 256   | Item names               |
| 12862 | `CS_PLAYERSKINS`  | 256   | Player skin strings      |
| 13118 | `CS_GENERAL`      | 512   | General strings          |

**Total:** 13630 configstrings (`MAX_CONFIGSTRINGS`)

**Extended entity/resource limits:**

| Limit         | Value |
|---------------|-------|
| `MAX_EDICTS`  | 8192  |
| `MAX_MODELS`  | 8192  |
| `MAX_SOUNDS`  | 2048  |
| `MAX_IMAGES`  | 2048  |

# Client and Server Settings

Settings are exchanged via `clc_setting` (client→server) and
`svc_setting` (server→client) messages, allowing runtime negotiation of
optional features.

## Client Settings

`clientSetting_t` enum values:

| Value | Constant           | Description                         |
|-------|--------------------|-------------------------------------|
| 0     | `CLS_NOGUN`        | Hide gun model (1=all, 2=keep idx) |
| 1     | `CLS_NOBLEND`      | Disable screen blends               |
| 2     | `CLS_RECORDING`    | Client is recording a demo          |
| 3     | `CLS_PLAYERUPDATES`| R1Q2 player updates                 |
| 4     | `CLS_FPS`          | Client FPS setting                  |
| 10    | `CLS_NOGIBS`       | Disable gibs (Q2PRO)               |
| 11    | `CLS_NOFOOTSTEPS`  | Disable footstep sounds (Q2PRO)    |
| 12    | `CLS_NOPREDICT`    | Disable prediction (Q2PRO)         |
| 13    | `CLS_NOFLARES`     | Disable flares (Q2PRO)             |

## Server Settings

`serverSetting_t` enum values:

| Value | Constant            | Description                        |
|-------|---------------------|------------------------------------|
| 0     | `SVS_PLAYERUPDATES` | Player update rate                 |
| 1     | `SVS_FPS`           | Server FPS                         |
| 2     | `SVS_VIEW_LOW`      | View low parameter                 |
| 3     | `SVS_VIEW_HIGH`     | View high parameter                |

# Frame Flags

In Q2PRO protocol (36), the suppress count field in the frame header
doubles as a frame flags field:

| Bit | Constant         | Description                              |
|-----|------------------|------------------------------------------|
| 0   | `FF_SUPPRESSED`  | Frame was rate-suppressed                |
| 1   | `FF_CLIENTDROP`  | Client-side packet was dropped           |
| 2   | `FF_CLIENTPRED`  | Client is predicting (no server update)  |
| 3   | `FF_RESERVED`    | Reserved for future use                  |

Only `SUPPRESSCOUNT_BITS` (4) bits are available for these flags.

# Sound Encoding

Sound effects are transmitted with a flags byte controlling which
optional fields are present:

| Bit | Flag              | Type    | Description                     |
|-----|-------------------|---------|---------------------------------|
| 0   | `SND_VOLUME`      | byte    | Volume (default: 1.0)           |
| 1   | `SND_ATTENUATION`  | byte    | Attenuation (default: 1.0)      |
| 2   | `SND_POS`          | 3 shorts| Sound origin position           |
| 3   | `SND_ENT`          | short   | Entity and channel (bits 0-2: channel, 3-15: entity) |
| 4   | `SND_OFFSET`       | byte    | Millisecond offset from frame start |
| 5   | `SND_INDEX16`      | —       | Sound index is 16-bit (else 8-bit) |

A sound without `SND_ENT` or `SND_POS` is played as a local-only
sound.

# Coordinate and Angle Quantization

Network coordinates and angles are quantized for compact transmission:

| Conversion     | Formula                | Precision         |
|----------------|------------------------|--------------------|
| Coord → short  | `(int)(coord * 8.0)`   | 1/8 unit (0.125)  |
| Short → coord  | `short * (1.0 / 8.0)`  | 1/8 unit (0.125)  |
| Angle → short  | `(int)(angle * 65536/360) & 65535` | ~0.0055° |
| Short → angle  | `short * (360.0 / 65536)` | ~0.0055°       |

Standard protocol 34 transmits angles as bytes (1/256th of a full
rotation, ~1.4° precision) for usercmds and entity updates. The
`U_ANGLE16` flag upgrades entity angles to 16-bit precision. Q2PRO
with `MSG_ES_SHORTANGLES` (minor version ≥ 1018) uses 16-bit angles
by default for entities.

Solid bounds are packed as either a 16-bit value (protocol 34) or
32-bit value (R1Q2 with `MSG_ES_LONGSOLID`, Q2PRO, AQtion). The
special value `PACKED_BSP` (31) indicates a BSP model solid.
