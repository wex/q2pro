# Sound events

Branch: `feat/sound-events`

## Scope

Surface decoded start-sound packets from the MVD parser so consumers can
localize footsteps, gunfire, and pickups — both for programmatic use (the
`sound` SSE feed) and as a positional ping on the browser map.

## Protocol touchpoints

Two wire forms carry sound packets; they are **not** interchangeable:

| | `mvd_sound` (top-level MVD op 16) | `svc_sound` (inside unicast/multicast) |
|---|---|---|
| flags | `u8` | `u8` |
| index | `u8`, or `u16` when `extended && SND_INDEX16` | same |
| volume | `u8` if `SND_VOLUME` | same |
| attenuation | `u8` if `SND_ATTENUATION` | same |
| offset | `u8` if `SND_OFFSET` | same |
| entity/channel | **always** `u16 sendchan` | `u16` only when `SND_ENT` |
| position | never | `pos` only when `SND_POS` |

References: `MVD_ParseSound` (`src/server/mvd/parse.c:423`) — the server
reads the outer form, derives the entity origin itself, and re-emits a
client-facing `svc_sound` with `SND_POS` added; `CL_ParseStartSoundPacket`
(`src/client/parse.c:1019`) — the inner form read by real clients.

Field semantics (all decoded into `SoundEvent`):

- `volume` = byte/255, default **1.0**
- `attenuation` = byte/64, default **1.0** (`ATTN_NORM`)
- `timeOffset` = byte/1000 s, default **0**
- `sendchan` → `entity = word >> 3`, `channel = word & 7`

On `esFlags & MSG_ES_EXTENSIONS_2` streams, `SND_POS` coordinates use the
ext2 16/23-bit encoding — `readPos` already handles both.

## API

```ts
parser.onSound = (ev: SoundEvent) => { ... };
```

```ts
interface SoundEvent {
    flags: number;          // raw SND_* byte
    index: number;          // into the CS_SOUNDS configstring range
    volume: number;         // 0..1
    attenuation: number;
    timeOffset: number;     // seconds
    entity: number;         // 0 = auto/world
    channel: number;        // 0..7
    position?: [number, number, number]; // only for SND_POS (inner svc_sound)
}
```

Name resolution lives at the application layer, not in the parser:
`configstrings.get(csLayout(extended).sounds + index)` — `CsLayout.sounds`
is `288` (vanilla) / `8254` (`MVF_EXTLIMITS`), from `cs_remap_new` in the C
server. `CS_LAYOUT_OLD` / `CS_LAYOUT_EXT` and `CS_SOUNDS_OLD` /
`CS_SOUNDS_EXT` are exported via `index.ts`.

## SSE / UI

`app.ts` broadcasts `event: sound` with
`{ index, name, entity, channel, position, volume, attenuation, t }`.
`name` is `undefined` when the slot is empty (e.g. a sound fired before the
configstring range populated).

`public/app.js` renders events that carry a `position` as a cyan expanding
ring on the map (700 ms TTL, radius scales with volume, capped at 64 live
pings).

The outer `mvd_sound` op never carries `SND_POS` — the server derives the
entity's origin when re-emitting to real clients. `Session` mirrors that:
when an entity-attached event has no wire position, it looks up
`players.get(entity - 1)` (edicts 1..maxclients are the game clients) and
broadcasts the player's last frame origin — converted to world coords via
`originToWorld`, since `PlayerState.origin` is raw pmove units — as
`position`, flagged `posDerived: true`. This covers footsteps, pain calls, and any other
`gi.sound()`-style audio; the derived position can lag one frame when the
sound op precedes `mvd_frame` in the same message. The UI renders derived
pings as a smaller, dimmer pulse to distinguish "player made noise" from
positional impacts. Wire `SND_POS` positions always win.

Sounds that resolve no entity (world edicts, `entity: 0` auto-positioned,
or slots with no live playerstate) still reach the SSE feed unpositioned
and are not pinged.

## Usage

Nothing to configure — the events flow with every live stream and `.mvd2`
replay. Library consumers opt in by assigning `parser.onSound`.
