# Texture Toggle

Toggle WAL texture rendering on the map view via a status-bar button or the `T` hotkey.

## Scope

The map view renders BSP geometry as an SVG using WAL texture patterns when textures are
available.  When textures are disabled, polygons fall back to a deterministic height-based
HSL colour scheme (the same path taken when no texture files are present).

The toggle affects only the 2-D top-down map canvas; player positions, combat FX, and all
other overlays are unaffected.

## Protocol touchpoint

### `GET /maps/{name}?notextures`

When the `notextures` query parameter is present, `app.ts` skips `prepareTexturesDir()` and
`prepareColormap()` and calls `generateMapSvg` with `texturesDir: undefined` and
`colormapPath: undefined`.  The resulting SVG contains no `<defs>` / `<pattern>` elements
and uses height-based HSL fills for all polygons.

Without the parameter the behaviour is unchanged: textures are loaded from disk / PAK and
embedded as SVG patterns.

## Browser UI

### Toggle button

`#btn-textures` lives in the `#status` bar at the top-left corner.

| State | Label | CSS class |
|-------|-------|-----------|
| On (default) | `Tex ✓` | *(none)* |
| Off | `Tex ✗` | `tex-off` |

### Hotkey

`T` (or `Shift-T`) — ignored when focus is inside an `<input>`, `<textarea>`, or `<select>`.

## Client behaviour

`texturesEnabled` is a module-level boolean in `app.js` (default `true`).

`toggleTextures()`:
1. Flips `texturesEnabled`.
2. Updates the button label and `tex-off` class.
3. Calls `loadMap(currentMapname)` if a map is loaded, which re-fetches the SVG with or
   without `?notextures` and re-rasterizes it.

The state persists across map changes: if textures are off when a new map loads, the new map
is also fetched without textures.

## Files changed

| File | Change |
|------|--------|
| `ts-mvd/src/app.ts` | `?notextures` param in `GET /maps/{name}` |
| `ts-mvd/public/index.html` | `#btn-textures` button in `#status` |
| `ts-mvd/public/app.css` | Styles for `#btn-textures` on/off states |
| `ts-mvd/public/app.js` | `texturesEnabled`, `toggleTextures()`, `T` hotkey, button wiring, `?notextures` in `loadMap` |
| `ts-mvd/test/app.test.ts` | Regression tests: `GET /maps/{unknown}` and `GET /maps/{unknown}?notextures` both return 404 |
