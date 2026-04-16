import * as fs from 'node:fs';

// ─── Disk-format constants ────────────────────────────────────────────────────

const IDBSP_MAGIC = 0x50534249; // 'IBSP' little-endian
const QBSP_MAGIC = 0x50534251; // 'QBSP' little-endian (extended)
const BSP_VERSION = 38;
const HEADER_LUMPS = 19;
const MAX_TEXNAME = 32;
const MAX_LIGHTMAPS = 4;

// Lump indices
const LUMP_ENTITIES = 0;
const LUMP_PLANES = 1;
const LUMP_VERTICES = 2;
// LUMP_VISIBILITY   =  3  (not parsed here)
// LUMP_NODES        =  4  (not parsed here)
const LUMP_TEXINFO = 5;
const LUMP_FACES = 6;
// LUMP_LIGHTMAP     =  7  (not parsed here)
// LUMP_LEAFS        =  8  (not parsed here)
// LUMP_LEAFFACES    =  9  (not parsed here)
// LUMP_LEAFBRUSHES  = 10  (not parsed here)
const LUMP_EDGES = 11;
const LUMP_SURFEDGES = 12;
const LUMP_MODELS = 13;

// ─── Surface-flag constants (texinfo.flags) ───────────────────────────────────

export const SURF_LIGHT = 0x001;
export const SURF_SLICK = 0x002;
export const SURF_SKY = 0x004;
export const SURF_WARP = 0x008; // water / liquid
export const SURF_TRANS33 = 0x010;
export const SURF_TRANS66 = 0x020;
export const SURF_FLOWING = 0x040;
export const SURF_NODRAW = 0x080;
export const SURF_HINT = 0x100;
export const SURF_SKIP = 0x200;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Plane {
  normal: Vec3;
  dist: number;
}

export interface Texinfo {
  axisU: Vec3;
  offsetU: number;
  axisV: Vec3;
  offsetV: number;
  flags: number;
  value: number;
  name: string;
}

export interface Face {
  planenum: number;
  side: number;      // 1 = back side of plane (DSURF_PLANEBACK)
  firstedge: number; // index into surfedges array
  numedges: number;
  texinfo: number;   // index into texinfo array
  styles: number[];  // 4 light-style bytes
  lightofs: number;  // byte offset into lightmap lump (-1 = no lightmap)
}

export interface BspModel {
  mins: Vec3;
  maxs: Vec3;
  origin: Vec3;
  headnode: number;  // index into nodes array
  firstface: number; // index into faces array
  numfaces: number;
}

// ─── Main class ───────────────────────────────────────────────────────────────

export class BspFile {
  readonly vertices: Vec3[];
  readonly edges: [number, number][];
  readonly surfedges: number[];
  readonly faces: Face[];
  readonly texinfo: Texinfo[];
  readonly planes: Plane[];
  readonly models: BspModel[];
  readonly entityString: string;
  readonly extended: boolean; // true = QBSP (32-bit edge/face indices)

  private constructor(fields: {
    vertices: Vec3[];
    edges: [number, number][];
    surfedges: number[];
    faces: Face[];
    texinfo: Texinfo[];
    planes: Plane[];
    models: BspModel[];
    entityString: string;
    extended: boolean;
  }) {
    this.vertices = fields.vertices;
    this.edges = fields.edges;
    this.surfedges = fields.surfedges;
    this.faces = fields.faces;
    this.texinfo = fields.texinfo;
    this.planes = fields.planes;
    this.models = fields.models;
    this.entityString = fields.entityString;
    this.extended = fields.extended;
  }

  // ─── Constructors ────────────────────────────────────────────────────────────

  static load(buf: Buffer): BspFile {
    const magic = buf.readUInt32LE(0);
    if (magic !== IDBSP_MAGIC && magic !== QBSP_MAGIC)
      throw new Error(`Not a Quake 2 BSP file (magic = 0x${magic.toString(16).padStart(8, '0')})`);

    const extended = magic === QBSP_MAGIC;

    const version = buf.readUInt32LE(4);
    if (version !== BSP_VERSION)
      throw new Error(`Unsupported BSP version ${version} (expected ${BSP_VERSION})`);

    // Read the lump directory (19 entries × 8 bytes at offset 8)
    const lumpOfs = new Array<number>(HEADER_LUMPS);
    const lumpLen = new Array<number>(HEADER_LUMPS);
    for (let i = 0; i < HEADER_LUMPS; i++) {
      const base = 8 + i * 8;
      lumpOfs[i] = buf.readUInt32LE(base);
      lumpLen[i] = buf.readUInt32LE(base + 4);
    }

    return new BspFile({
      entityString: parseEntities(buf, lumpOfs[LUMP_ENTITIES], lumpLen[LUMP_ENTITIES]),
      planes: parsePlanes(buf, lumpOfs[LUMP_PLANES], lumpLen[LUMP_PLANES]),
      vertices: parseVertices(buf, lumpOfs[LUMP_VERTICES], lumpLen[LUMP_VERTICES]),
      texinfo: parseTexinfo(buf, lumpOfs[LUMP_TEXINFO], lumpLen[LUMP_TEXINFO]),
      faces: parseFaces(buf, lumpOfs[LUMP_FACES], lumpLen[LUMP_FACES], extended),
      edges: parseEdges(buf, lumpOfs[LUMP_EDGES], lumpLen[LUMP_EDGES], extended),
      surfedges: parseSurfEdges(buf, lumpOfs[LUMP_SURFEDGES], lumpLen[LUMP_SURFEDGES]),
      models: parseModels(buf, lumpOfs[LUMP_MODELS], lumpLen[LUMP_MODELS]),
      extended,
    });
  }

  static loadFile(filePath: string): BspFile {
    return BspFile.load(fs.readFileSync(filePath));
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve the vertex polygon for a face by walking the
   * surfedge → edge → vertex chain.
   */
  getFacePolygon(faceIdx: number): Vec3[] {
    const face = this.faces[faceIdx];
    const verts: Vec3[] = [];
    for (let i = 0; i < face.numedges; i++) {
      const se = this.surfedges[face.firstedge + i];
      // Positive surfedge → use edge.v[0], negative → edge.v[1]
      const edgeIdx = se < 0 ? -se : se;
      const edge = this.edges[edgeIdx];
      verts.push(this.vertices[se >= 0 ? edge[0] : edge[1]]);
    }
    return verts;
  }

  /**
   * The worldspawn model (models[0]) contains the static world geometry.
   */
  getWorldModel(): BspModel {
    if (this.models.length === 0) throw new Error('BSP has no models');
    return this.models[0];
  }

  /**
   * The face normal, accounting for the DSURF_PLANEBACK flip.
   */
  getFaceNormal(faceIdx: number): Vec3 {
    const face = this.faces[faceIdx];
    const n = this.planes[face.planenum].normal;
    return face.side ? { x: -n.x, y: -n.y, z: -n.z } : { x: n.x, y: n.y, z: n.z };
  }

  /**
   * Parse entity key/value blocks from the entity lump.
   * Returns an array of plain objects.
   */
  parseEntities(): Record<string, string>[] {
    return parseEntityKeyValues(this.entityString);
  }
}

// ─── Lump parsers ─────────────────────────────────────────────────────────────

function parseEntities(buf: Buffer, ofs: number, len: number): string {
  return buf.subarray(ofs, ofs + len).toString('ascii').replace(/\0+$/, '');
}

/**
 * Lump 1 — Planes
 * Disk layout (20 bytes each, same for standard and extended):
 *   float32 normal[3]  (12 bytes)
 *   float32 dist       ( 4 bytes)
 *   int32   type       ( 4 bytes, not needed for rendering — skipped)
 */
function parsePlanes(buf: Buffer, ofs: number, len: number): Plane[] {
  const count = Math.floor(len / 20);
  const out: Plane[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += 20) {
    out[i] = {
      normal: {
        x: buf.readFloatLE(p),
        y: buf.readFloatLE(p + 4),
        z: buf.readFloatLE(p + 8),
      },
      dist: buf.readFloatLE(p + 12),
    };
  }
  return out;
}

/**
 * Lump 2 — Vertices
 * Disk layout (12 bytes each):
 *   float32 x, y, z
 */
function parseVertices(buf: Buffer, ofs: number, len: number): Vec3[] {
  const count = Math.floor(len / 12);
  const out: Vec3[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += 12) {
    out[i] = {
      x: buf.readFloatLE(p),
      y: buf.readFloatLE(p + 4),
      z: buf.readFloatLE(p + 8),
    };
  }
  return out;
}

/**
 * Lump 5 — Texinfo
 * Disk layout (76 bytes each, same for standard and extended):
 *   float32 axisU[3]   (12 bytes)
 *   float32 offsetU    ( 4 bytes)
 *   float32 axisV[3]   (12 bytes)
 *   float32 offsetV    ( 4 bytes)
 *   int32   flags      ( 4 bytes)
 *   int32   value      ( 4 bytes)
 *   char    name[32]   (32 bytes)
 *   int32   next       ( 4 bytes, anim chain — not needed here)
 */
function parseTexinfo(buf: Buffer, ofs: number, len: number): Texinfo[] {
  const count = Math.floor(len / 76);
  const out: Texinfo[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += 76) {
    const axisU: Vec3 = {
      x: buf.readFloatLE(p),
      y: buf.readFloatLE(p + 4),
      z: buf.readFloatLE(p + 8),
    };
    const offsetU = buf.readFloatLE(p + 12);
    const axisV: Vec3 = {
      x: buf.readFloatLE(p + 16),
      y: buf.readFloatLE(p + 20),
      z: buf.readFloatLE(p + 24),
    };
    const offsetV = buf.readFloatLE(p + 28);
    const flags = buf.readInt32LE(p + 32);
    const value = buf.readInt32LE(p + 36);

    // Null-terminated texture name
    const nameEnd = buf.indexOf(0, p + 40);
    const name = buf
      .subarray(p + 40, nameEnd >= 0 && nameEnd < p + 40 + MAX_TEXNAME ? nameEnd : p + 40 + MAX_TEXNAME)
      .toString('ascii');

    out[i] = { axisU, offsetU, axisV, offsetV, flags, value, name };
  }
  return out;
}

/**
 * Lump 6 — Faces
 *
 * Standard (non-extended) disk layout (20 bytes each):
 *   uint16  planenum   ( 2 bytes)
 *   uint16  side       ( 2 bytes, bit 0 = DSURF_PLANEBACK)
 *   int32   firstedge  ( 4 bytes)
 *   uint16  numedges   ( 2 bytes)
 *   uint16  texinfo    ( 2 bytes)
 *   uint8   styles[4]  ( 4 bytes)
 *   int32   lightofs   ( 4 bytes)
 *
 * Extended (QBSP) disk layout (28 bytes each):
 *   uint32  planenum   ( 4 bytes)
 *   uint32  side       ( 4 bytes)
 *   int32   firstedge  ( 4 bytes)
 *   uint32  numedges   ( 4 bytes)
 *   uint32  texinfo    ( 4 bytes)
 *   uint8   styles[4]  ( 4 bytes)
 *   int32   lightofs   ( 4 bytes)
 */
function parseFaces(buf: Buffer, ofs: number, len: number, extended: boolean): Face[] {
  const stride = extended ? 28 : 20;
  const count = Math.floor(len / stride);
  const out: Face[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += stride) {
    let planenum: number, side: number, firstedge: number, numedges: number, texinfo: number, lightofs: number;
    const styles: number[] = new Array(MAX_LIGHTMAPS);

    if (extended) {
      planenum = buf.readUInt32LE(p);
      side = buf.readUInt32LE(p + 4) & 1;
      firstedge = buf.readInt32LE(p + 8);
      numedges = buf.readUInt32LE(p + 12);
      texinfo = buf.readUInt32LE(p + 16);
      for (let j = 0; j < MAX_LIGHTMAPS; j++) styles[j] = buf[p + 20 + j];
      lightofs = buf.readInt32LE(p + 24);
    } else {
      planenum = buf.readUInt16LE(p);
      side = buf.readUInt16LE(p + 2) & 1;
      firstedge = buf.readInt32LE(p + 4);
      numedges = buf.readUInt16LE(p + 8);
      texinfo = buf.readUInt16LE(p + 10);
      for (let j = 0; j < MAX_LIGHTMAPS; j++) styles[j] = buf[p + 12 + j];
      lightofs = buf.readInt32LE(p + 16);
    }

    out[i] = { planenum, side, firstedge, numedges, texinfo, styles, lightofs };
  }
  return out;
}

/**
 * Lump 11 — Edges
 *
 * Standard disk layout (4 bytes each):   uint16 v[2]
 * Extended disk layout (8 bytes each):   uint32 v[2]
 */
function parseEdges(buf: Buffer, ofs: number, len: number, extended: boolean): [number, number][] {
  const stride = extended ? 8 : 4;
  const count = Math.floor(len / stride);
  const out: [number, number][] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += stride) {
    if (extended) {
      out[i] = [buf.readUInt32LE(p), buf.readUInt32LE(p + 4)];
    } else {
      out[i] = [buf.readUInt16LE(p), buf.readUInt16LE(p + 2)];
    }
  }
  return out;
}

/**
 * Lump 12 — SurfEdges
 * Disk layout (4 bytes each): int32
 *   Positive value → use edge.v[0] as start vertex
 *   Negative value → use edge.v[1] as start vertex (abs = edge index)
 */
function parseSurfEdges(buf: Buffer, ofs: number, len: number): number[] {
  const count = Math.floor(len / 4);
  const out: number[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += 4) {
    out[i] = buf.readInt32LE(p);
  }
  return out;
}

/**
 * Lump 13 — Models (sub-models / inline brushes)
 * Disk layout (48 bytes each, same for standard and extended):
 *   float32 mins[3]    (12 bytes)
 *   float32 maxs[3]    (12 bytes)
 *   float32 origin[3]  (12 bytes)
 *   int32   headnode   ( 4 bytes)
 *   int32   firstface  ( 4 bytes)
 *   int32   numfaces   ( 4 bytes)
 */
function parseModels(buf: Buffer, ofs: number, len: number): BspModel[] {
  const count = Math.floor(len / 48);
  const out: BspModel[] = new Array(count);
  let p = ofs;
  for (let i = 0; i < count; i++, p += 48) {
    out[i] = {
      mins: {
        x: buf.readFloatLE(p),
        y: buf.readFloatLE(p + 4),
        z: buf.readFloatLE(p + 8),
      },
      maxs: {
        x: buf.readFloatLE(p + 12),
        y: buf.readFloatLE(p + 16),
        z: buf.readFloatLE(p + 20),
      },
      origin: {
        x: buf.readFloatLE(p + 24),
        y: buf.readFloatLE(p + 28),
        z: buf.readFloatLE(p + 32),
      },
      headnode: buf.readInt32LE(p + 36),
      firstface: buf.readInt32LE(p + 40),
      numfaces: buf.readInt32LE(p + 44),
    };
  }
  return out;
}

// ─── Entity string parser ─────────────────────────────────────────────────────

/**
 * Parse Quake entity string into an array of key/value objects.
 * Format:  { "key" "value" "key2" "value2" }
 */
function parseEntityKeyValues(entityString: string): Record<string, string>[] {
  const entities: Record<string, string>[] = [];
  const blockRe = /\{([^}]*)\}/g;
  const pairRe = /"([^"]+)"\s+"([^"]*)"/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(entityString)) !== null) {
    const block = blockMatch[1];
    const ent: Record<string, string> = {};
    let pairMatch: RegExpExecArray | null;
    pairRe.lastIndex = 0;
    while ((pairMatch = pairRe.exec(block)) !== null) {
      ent[pairMatch[1]] = pairMatch[2];
    }
    entities.push(ent);
  }
  return entities;
}
