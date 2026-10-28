# Configstring layouts (vanilla vs MVF_EXTLIMITS)

Q2Pro MVD streams ship configstrings in one of two layouts, mirroring
`cs_remap_old` / `cs_remap_new` in `src/server/mvd/parse.c`:

| Block          | OLD (vanilla) | EXT (MVF_EXTLIMITS) |
|----------------|---------------|---------------------|
| CS_MAXCLIENTS  | 30            | 60                  |
| CS_MODELS      | 32            | 62                  |
| CS_SOUNDS      | 288           | 8254                |
| CS_IMAGES      | 544           | 10302               |
| CS_LIGHTS      | 800           | 12350               |
| CS_ITEMS       | 1056          | 12606               |
| CS_PLAYERSKINS | 1312          | 12862               |
| CS_GENERAL     | 1568          | 13118               |
| end            | 2080          | 13630               |

## The aliasing hazard

The EXT low indices (30–61) sit **inside** the vanilla `CS_MODELS` range
(32–287). Probing "EXT first, fall back to OLD" therefore reads a real but
unrelated model path on vanilla streams:

- `configstrings[60]` is `CS_MAXCLIENTS_EXT`, but on a vanilla stream it is
  `CS_MODELS + 28` — a `.md2` path. `parseInt` on it yields `NaN`, which
  silently disabled the scoreboard disconnect prune (`index < base + NaN`
  is always false) — see AUDIT.md finding 1.
- `CS_MODELS_EXT + gunindex` on a vanilla stream returns an unrelated model
  path, so the gunindex → weapon lookup never reached the correct OLD slot.

## The fix

`MvdFrameParser` already derives the layout the same way the C code does
(`version >= 2011 && flags & MVF_EXTLIMITS` → `cs_remap_new`). It now
exposes it as `ServerDataEvent.extended`, and consumers pick **exactly one**
base set:

- `player-loadout.ts`: `csLayout(extended)` returns `CS_LAYOUT_EXT` or
  `CS_LAYOUT_OLD` (`models`, `images`, `items`, `playerskins`, `maxclients`
  bases). All public resolvers take an optional `extended` parameter
  (default `false` = vanilla).
- `app.ts` tracks `csExtended` from serverdata, uses it for
  `serializePlayerForSse` and the playerskin disconnect prune, and forwards
  it to the browser via the `serverdata` / `snapshot` SSE payloads.
- `public/app.js` mirrors the same `csB()` base picker.

If a third layout is ever negotiated (e.g. a future protocol extension),
extend `CsLayout`/`csLayout()` rather than re-adding probes.
