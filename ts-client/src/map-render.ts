import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BspFile,
  SURF_NODRAW, SURF_SKIP,
  type Vec3,
} from './bsp.js';

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx src/map-render.ts <file.bsp> [output.svg] [--grid]');
  console.error('');
  console.error('Generates a 2D top-down SVG overview of a Quake 2 map.');
  console.error('  --grid   overlay a 64-unit coordinate grid aligned to the world origin');
  process.exit(1);
}

const showGrid = args.includes('--grid');
const positional = args.filter(a => !a.startsWith('--'));
const bspPath = positional[0];
const outPath = positional[1] ?? (path.basename(bspPath, path.extname(bspPath)) + '.svg');

console.log(`Loading ${bspPath} …`);
const bsp = BspFile.loadFile(bspPath);

const world = bsp.getWorldModel();

console.log(`Format  : ${bsp.extended ? 'QBSP (extended)' : 'IBSP (standard)'}`);
console.log(`Models  : ${bsp.models.length}`);
console.log(`Faces   : ${bsp.faces.length}  (world: ${world.numfaces})`);
console.log(`Vertices: ${bsp.vertices.length}`);
console.log(`Bounds  : [${fmtV(world.mins)}] – [${fmtV(world.maxs)}]`);

// ─── Coordinate projection ────────────────────────────────────────────────────
//
// Quake 2 uses a right-handed coordinate system:
//   +X = east,  +Y = north,  +Z = up
//
// Top-down (skybox) view: project onto the XY plane.
// SVG convention: Y grows downward, so we flip the world Y axis.
//   svgX =  worldX
//   svgY = -worldY  (north = up on screen)

const MARGIN = 80;
const LABEL_HEIGHT = 40; // space at top for map name

const worldW = world.maxs.x - world.mins.x;
const worldH = world.maxs.y - world.mins.y;

if (worldW <= 0 || worldH <= 0) {
  console.error('World bounds are degenerate — aborting.');
  process.exit(1);
}

// 1:1 scale — 1 world unit = 1 SVG pixel
const scale = 1;
const SVG_W = Math.round(worldW + 2 * MARGIN);
const SVG_H = Math.round(worldH + 2 * MARGIN + LABEL_HEIGHT);

function toSvg(worldX: number, worldY: number): [number, number] {
  return [
    MARGIN + (worldX - world.mins.x) * scale,
    LABEL_HEIGHT + MARGIN + (world.maxs.y - worldY) * scale, // flip Y
  ];
}

// ─── Face collection (first pass) ────────────────────────────────────────────
//
// From a top-down skybox view only upward-facing surfaces are visible:
// keep faces whose normal Z component is positive (nz > 0).
// Fill colour is determined in a second pass once global min/max Z is known.

interface PolyRecord {
  points: [number, number][];
  avgZ: number;     // average vertex Z — used for height colouring & sort
  fill: string;     // assigned after global min/max pass
}

const polys: PolyRecord[] = [];

function processFaces(firstface: number, numfaces: number): void {
  for (let fi = firstface; fi < firstface + numfaces; fi++) {
    const face = bsp.faces[fi];
    if (face.texinfo >= bsp.texinfo.length) continue;
    const ti = bsp.texinfo[face.texinfo];

    // Skip invisible / hint surfaces
    if (ti.flags & (SURF_NODRAW | SURF_SKIP)) continue;

    // Visibility filter: only surfaces whose normal points upward are
    // visible from above (skybox / top-down camera).
    const n = bsp.getFaceNormal(fi);
    if (n.z <= 0) continue;

    // Resolve polygon vertices
    const verts = bsp.getFacePolygon(fi);
    if (verts.length < 3) continue;

    const pts = verts.map(v => toSvg(v.x, v.y));
    const avgZ = verts.reduce((s, v) => s + v.z, 0) / verts.length;

    polys.push({ points: pts, avgZ, fill: '' }); // fill assigned below
  }
}

// World geometry (models[0])
processFaces(world.firstface, world.numfaces);

// Also render inline brush models (func_wall, func_door, etc.)
for (let mi = 1; mi < bsp.models.length; mi++) {
  const m = bsp.models[mi];
  processFaces(m.firstface, m.numfaces);
}

// ─── Second pass: assign grayscale fill by height ────────────────────────────
//
// black rgb(0,0,0) = lowest Z   white rgb(255,255,255) = highest Z

let minZ = Infinity, maxZ = -Infinity;
for (const p of polys) {
  if (p.avgZ < minZ) minZ = p.avgZ;
  if (p.avgZ > maxZ) maxZ = p.avgZ;
}

const zRange = maxZ - minZ || 1; // guard against flat maps
for (const p of polys) {
  const v = Math.round(((p.avgZ - minZ) / zRange) * 255);
  p.fill = `rgb(${v},${v},${v})`;
}

// Sort ascending by Z so lower floors render first (painter's algorithm)
polys.sort((a, b) => a.avgZ - b.avgZ);

console.log(`Polygons: ${polys.length}  Z range: ${minZ.toFixed(0)} – ${maxZ.toFixed(0)}`);

// ─── Entity markers ───────────────────────────────────────────────────────────

interface EntityMarker {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  label: string;
}

const markers: EntityMarker[] = [];

const entities = bsp.parseEntities();
for (const ent of entities) {
  const cls = ent['classname'] ?? '';
  const origin = parseOrigin(ent['origin']);
  if (!origin) continue;
  const [cx, cy] = toSvg(origin.x, origin.y);

  if (cls === 'info_player_start' || cls === 'info_player_deathmatch') {
    markers.push({ cx, cy, r: 10, fill: '#ee3333', label: 'S' });
  } else if (cls === 'info_player_coop') {
    markers.push({ cx, cy, r: 8, fill: '#ee8833', label: 'C' });
  } else if (cls.startsWith('weapon_') || cls.startsWith('ammo_')) {
    markers.push({ cx, cy, r: 5, fill: '#ddcc22', label: '' });
  } else if (cls.startsWith('item_') && cls.includes('health')) {
    markers.push({ cx, cy, r: 5, fill: '#22cc44', label: '' });
  }
}

console.log(`Markers : ${markers.length} entity markers`);

// ─── SVG assembly ─────────────────────────────────────────────────────────────

const mapName = path.basename(bspPath, path.extname(bspPath));

// ─── Coordinate grid ─────────────────────────────────────────────────────────
//
// Lines every 64 world units aligned to origin, drawn behind all geometry.

const GRID_STEP = 64;
const gridLines: string[] = [];

// SVG Y extent of the draw area
const gridTop = LABEL_HEIGHT + MARGIN;
const gridBottom = LABEL_HEIGHT + MARGIN + worldH;
const gridLeft = MARGIN;
const gridRight = MARGIN + worldW;

// Vertical lines (constant world X)
const xFirst = Math.ceil(world.mins.x / GRID_STEP) * GRID_STEP;
const xLast = Math.floor(world.maxs.x / GRID_STEP) * GRID_STEP;
for (let wx = xFirst; wx <= xLast; wx += GRID_STEP) {
  const [sx] = toSvg(wx, 0);
  const isAxis = wx === 0;
  gridLines.push(
    `  <line x1="${sx.toFixed(1)}" y1="${gridTop}" x2="${sx.toFixed(1)}" y2="${gridBottom}"` +
    ` stroke="rgb(0,255,0)" stroke-width="${isAxis ? 1 : 0.5}" opacity="${isAxis ? 0.9 : 0.9}"/>`,
  );
}

// Horizontal lines (constant world Y — remember Y is flipped in SVG)
const yFirst = Math.ceil(world.mins.y / GRID_STEP) * GRID_STEP;
const yLast = Math.floor(world.maxs.y / GRID_STEP) * GRID_STEP;
for (let wy = yFirst; wy <= yLast; wy += GRID_STEP) {
  const [, sy] = toSvg(0, wy);
  const isAxis = wy === 0;
  gridLines.push(
    `  <line x1="${gridLeft}" y1="${sy.toFixed(1)}" x2="${gridRight}" y2="${sy.toFixed(1)}"` +
    ` stroke="rgb(0,255,0)" stroke-width="${isAxis ? 1 : 0.5}" opacity="${isAxis ? 0.9 : 0.9}"/>`,
  );
}

const gridElems = showGrid ? gridLines.join('\n') : '';

// Build face polygon elements
const polyElems = polys.map(p => {
  const d = p.points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)
    .join(' ') + ' Z';
  return `  <path d="${d}" fill="${p.fill}" stroke="rgba(0,0,0,0.3)" stroke-width="0.3" stroke-linejoin="round"/>`;
}).join('\n');

// Entity markers
const markerElems = markers.map(m => {
  const labelEl = m.label
    ? `<text x="${m.cx.toFixed(1)}" y="${(m.cy + 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold">${m.label}</text>`
    : '';
  return `  <circle cx="${m.cx.toFixed(1)}" cy="${m.cy.toFixed(1)}" r="${m.r}" fill="${m.fill}" opacity="0.9"/>${labelEl}`;
}).join('\n');

// Compass rose (top-right corner)
const compassX = SVG_W - MARGIN / 2;
const compassY = LABEL_HEIGHT + MARGIN / 2;
const compassR = 18;
// In our projection: +Y world = up on screen, +X world = right on screen
const compassSvg = `
  <g transform="translate(${compassX},${compassY})">
    <circle r="${compassR}" fill="#1a1a18" stroke="#555" stroke-width="1" opacity="0.7"/>
    <polygon points="0,${-compassR + 4} 4,0 -4,0" fill="#cc3333"/>
    <polygon points="0,${compassR - 4} 4,0 -4,0" fill="#666"/>
    <text y="${-compassR - 4}" text-anchor="middle" font-size="9" fill="#cc3333" font-family="sans-serif" font-weight="bold">N</text>
  </g>`;

// Scale bar
const scaleBarWorldUnits = Math.pow(10, Math.floor(Math.log10(worldW / 4)));
const scaleBarPx = scaleBarWorldUnits * scale;
const sbX = MARGIN;
const sbY = SVG_H - MARGIN / 2;
const scaleBarSvg = `
  <g>
    <line x1="${sbX}" y1="${sbY}" x2="${sbX + scaleBarPx}" y2="${sbY}" stroke="#aaa" stroke-width="2"/>
    <line x1="${sbX}" y1="${sbY - 4}" x2="${sbX}" y2="${sbY + 4}" stroke="#aaa" stroke-width="1.5"/>
    <line x1="${sbX + scaleBarPx}" y1="${sbY - 4}" x2="${sbX + scaleBarPx}" y2="${sbY + 4}" stroke="#aaa" stroke-width="1.5"/>
    <text x="${sbX + scaleBarPx / 2}" y="${sbY - 7}" text-anchor="middle" font-size="10" fill="#aaa" font-family="monospace">${scaleBarWorldUnits} units</text>
  </g>`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${SVG_W}" height="${SVG_H}"
     viewBox="0 0 ${SVG_W} ${SVG_H}">

  <!-- Background -->
  <rect width="${SVG_W}" height="${SVG_H}" fill="#000000"/>

  <!-- Map name -->
  <text x="${SVG_W / 2}" y="${LABEL_HEIGHT - 8}"
        text-anchor="middle" font-size="22" fill="#ccccaa"
        font-family="monospace" font-weight="bold">${escapeXml(mapName)}</text>

  <!-- World geometry -->
${polyElems}

${showGrid ? '  <!-- Coordinate grid (64-unit steps, world origin) -->' : ''}
${gridElems}

  <!-- Entity markers -->
${markerElems}

  <!-- Compass -->
${compassSvg}

  <!-- Scale bar -->
${scaleBarSvg}

</svg>
`;

fs.writeFileSync(outPath, svg, 'utf8');
console.log(`Output  : ${outPath}  (${SVG_W} × ${SVG_H} px)`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtV(v: Vec3): string {
  return `${v.x.toFixed(0)}, ${v.y.toFixed(0)}, ${v.z.toFixed(0)}`;
}

function parseOrigin(s: string | undefined): Vec3 | null {
  if (!s) return null;
  const p = s.trim().split(/\s+/).map(Number);
  if (p.length < 3 || p.some(isNaN)) return null;
  return { x: p[0], y: p[1], z: p[2] };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
