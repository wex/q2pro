import * as path from 'node:path';
import * as fs from 'node:fs';

/** Absolute path to the canonical demo fixture shipped with the repo. */
export const DEMO_PATH = path.resolve(__dirname, '..', '..', 'assets', 'demos', 'demo.mvd2');

export function readDemoBytes(): Buffer {
    return fs.readFileSync(DEMO_PATH);
}

/**
 * Build a synthetic `.mvd2` buffer from pre-formed message payloads.
 * Appends a uint16(0) EOF marker when `withEof` is true.
 */
export function buildMvd2(messages: Buffer[], withEof = true): Buffer {
    const magic = Buffer.from('MVD2', 'ascii');
    const parts: Buffer[] = [magic];
    for (const msg of messages) {
        const len = Buffer.alloc(2);
        len.writeUInt16LE(msg.length);
        parts.push(len, msg);
    }
    if (withEof) {
        const eof = Buffer.alloc(2);
        eof.writeUInt16LE(0);
        parts.push(eof);
    }
    return Buffer.concat(parts);
}

/**
 * Minimal valid Quake 2 BSP (IBSP v38): one quad face on a +Z plane inside
 * the world model — enough to exercise BspFile.getFacePolygon/getFaceNormal
 * and the map-render pipeline without real map assets.
 *
 * Lump layout matches `src/bsp.ts` parsers; only the lumps the renderer
 * consumes are populated.
 */
export function buildSynthBsp(
    entityString = '{ "classname" "worldspawn" }',
): Buffer {
    const HEADER = 8 + 19 * 8;

    const entities = Buffer.from(entityString + '\0', 'latin1');

    const planes = Buffer.alloc(20);
    planes.writeFloatLE(0, 0);   // normal.x
    planes.writeFloatLE(0, 4);   // normal.y
    planes.writeFloatLE(1, 8);   // normal.z → +Z (visible from top-down)
    // dist @12 and type @16 stay 0

    const verts = Buffer.alloc(4 * 12);
    const quad: Array<[number, number, number]> = [
        [0, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0],
    ];
    quad.forEach(([x, y, z], i) => {
        verts.writeFloatLE(x, i * 12);
        verts.writeFloatLE(y, i * 12 + 4);
        verts.writeFloatLE(z, i * 12 + 8);
    });

    const texinfo = Buffer.alloc(76);
    texinfo.writeFloatLE(1, 0);   // axisU = +X
    texinfo.writeFloatLE(1, 20);  // axisV = +Y
    // flags/value @32/@36 stay 0
    texinfo.write('test/synth', 40, 'ascii');

    const faces = Buffer.alloc(20);
    faces.writeUInt16LE(0, 0);     // planenum
    faces.writeUInt16LE(0, 2);     // side
    faces.writeInt32LE(0, 4);      // firstedge
    faces.writeUInt16LE(4, 8);     // numedges
    faces.writeUInt16LE(0, 10);    // texinfo
    faces.writeInt32LE(-1, 16);    // lightofs

    const edges = Buffer.alloc(4 * 4);
    [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([a, b], i) => {
        edges.writeUInt16LE(a, i * 4);
        edges.writeUInt16LE(b, i * 4 + 2);
    });

    const surfedges = Buffer.alloc(4 * 4);
    [0, 1, 2, 3].forEach((se, i) => surfedges.writeInt32LE(se, i * 4));

    const models = Buffer.alloc(48);
    // mins = (0,0,0), maxs = (64,64,16)
    models.writeFloatLE(64, 12);
    models.writeFloatLE(64, 16);
    models.writeFloatLE(16, 20);
    models.writeInt32LE(0, 40);   // firstface
    models.writeInt32LE(1, 44);   // numfaces

    const lumpData = new Map<number, Buffer>([
        [0, entities],   // LUMP_ENTITIES
        [1, planes],     // LUMP_PLANES
        [2, verts],      // LUMP_VERTICES
        [5, texinfo],    // LUMP_TEXINFO
        [6, faces],      // LUMP_FACES
        [11, edges],     // LUMP_EDGES
        [12, surfedges], // LUMP_SURFEDGES
        [13, models],    // LUMP_MODELS
    ]);

    const header = Buffer.alloc(HEADER);
    header.writeUInt32LE(0x50534249, 0); // 'IBSP'
    header.writeUInt32LE(38, 4);

    let ofs = HEADER;
    const parts: Buffer[] = [];
    for (let i = 0; i < 19; i++) {
        const d = lumpData.get(i);
        if (!d) continue;
        header.writeUInt32LE(ofs, 8 + i * 8);
        header.writeUInt32LE(d.length, 8 + i * 8 + 4);
        parts.push(d);
        ofs += d.length;
    }
    return Buffer.concat([header, ...parts]);
}
