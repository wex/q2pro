import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BspFile,
  SURF_SKY, SURF_WARP, SURF_NODRAW, SURF_SKIP,
  SURF_TRANS33, SURF_TRANS66,
  type Vec3,
} from './bsp.js';

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: npx tsx src/map-render.ts <file.bsp> [output.svg]');
  console.error('');
  console.error('Generates a 2D top-down SVG overview of a Quake 2 map.');
  process.exit(1);
}

const bspPath = args[0];
const outPath = args[1] ?? (path.basename(bspPath, path.extname(bspPath)) + '.svg');

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

const SVG_W        = 2048;
const MARGIN       = 80;
const LABEL_HEIGHT = 40; // space at top for map name

const worldW = world.maxs.x - world.mins.x;
const worldH = world.maxs.y - world.mins.y;

if (worldW <= 0 || worldH <= 0) {
  console.error('World bounds are degenerate — aborting.');
  process.exit(1);
}

const drawW = SVG_W - 2 * MARGIN;
const scale  = drawW / worldW;
const drawH  = worldH * scale;
const SVG_H  = Math.round(drawH + 2 * MARGIN + LABEL_HEIGHT);

function toSvg(worldX: number, worldY: number): [number, number] {
  return [
    MARGIN + (worldX - world.mins.x) * scale,
    LABEL_HEIGHT + MARGIN + (world.maxs.y - worldY) * scale, // flip Y
  ];
}

// ─── Face categorisation ──────────────────────────────────────────────────────

interface PolyRecord {
  points: [number, number][];
  fill: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  layer: number; // draw order: lower = behind
}

const polys: PolyRecord[] = [];

function processFaces(firstface: number, numfaces: number): void {
  for (let fi = firstface; fi < firstface + numfaces; fi++) {
    const face = bsp.faces[fi];
    if (face.texinfo >= bsp.texinfo.length) continue;
    const ti  = bsp.texinfo[face.texinfo];

    // Skip purely invisible surfaces
    if (ti.flags & (SURF_NODRAW | SURF_SKIP)) continue;

    // Resolve polygon vertices
    const verts = bsp.getFacePolygon(fi);
    if (verts.length < 3) continue;

    const pts = verts.map(v => toSvg(v.x, v.y));

    // Face normal (accounts for DSURF_PLANEBACK)
    const n = bsp.getFaceNormal(fi);

    // ── Classify & colour ────────────────────────────────────────────────────
    let fill: string;
    let strokeColor = '#2a2a22';
    let strokeWidth = 0.4;
    let opacity: number;
    let layer: number;

    if (ti.flags & SURF_SKY) {
      // Sky / open ceiling
      fill        = '#7aaec8';
      opacity     = 0.55;
      layer       = 0;
      strokeWidth = 0;
    } else if (ti.flags & SURF_WARP) {
      // Liquid (water, slime, lava)
      const isLava  = ti.name.toLowerCase().includes('lava');
      const isSlime = ti.name.toLowerCase().includes('slime');
      fill    = isLava ? '#cc5500' : isSlime ? '#55aa44' : '#3377cc';
      opacity = 0.70;
      layer   = 2;
    } else if (ti.flags & (SURF_TRANS33 | SURF_TRANS66)) {
      // Translucent surface (glass, grate)
      fill    = '#99ccaa';
      opacity = 0.35;
      layer   = 2;
    } else if (n.z > 0.7) {
      // Floor — the primary visible surface from above
      fill        = '#d8d3cb';
      strokeColor = '#b0a898';
      strokeWidth = 0.3;
      opacity     = 1.0;
      layer       = 4;
    } else if (n.z < -0.7) {
      // Ceiling — visible from above but behind floors
      fill    = '#b8b2a8';
      opacity = 0.45;
      layer   = 1;
    } else {
      // Wall — vertical geometry, gives the map its outline
      fill        = '#8a8880';
      strokeColor = '#3a3830';
      strokeWidth = 0.5;
      opacity     = 0.75;
      layer       = 3;
    }

    polys.push({ points: pts, fill, strokeColor, strokeWidth, opacity, layer });
  }
}

// World geometry (models[0])
processFaces(world.firstface, world.numfaces);

// Also render inline brush models (func_wall, func_door, etc.)
for (let mi = 1; mi < bsp.models.length; mi++) {
  const m = bsp.models[mi];
  processFaces(m.firstface, m.numfaces);
}

// Sort: lower layer drawn first (underneath)
polys.sort((a, b) => a.layer - b.layer);

console.log(`Polygons: ${polys.length}`);

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
  const cls    = ent['classname'] ?? '';
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

// Build face polygon elements grouped by layer
const polyElems = polys.map(p => {
  const d = p.points
    .map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`)
    .join(' ') + ' Z';
  const stroke = p.strokeWidth > 0
    ? `stroke="${p.strokeColor}" stroke-width="${p.strokeWidth}"`
    : 'stroke="none"';
  return `  <path d="${d}" fill="${p.fill}" ${stroke} opacity="${p.opacity}" stroke-linejoin="round"/>`;
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
  <rect width="${SVG_W}" height="${SVG_H}" fill="#141412"/>

  <!-- Map name -->
  <text x="${SVG_W / 2}" y="${LABEL_HEIGHT - 8}"
        text-anchor="middle" font-size="22" fill="#ccccaa"
        font-family="monospace" font-weight="bold">${escapeXml(mapName)}</text>

  <!-- World geometry -->
${polyElems}

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
