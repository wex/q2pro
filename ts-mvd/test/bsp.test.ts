import { BspFile } from '../src/bsp';
import { buildSynthBsp } from './helpers/fixtures';

describe('BspFile.load bounds checks', () => {
    test('rejects truncated header', () => {
        const buf = Buffer.alloc(20);
        buf.writeUInt32LE(0x50534249, 0); // 'IBSP'
        buf.writeUInt32LE(38, 4); // BSP_VERSION
        expect(() => BspFile.load(buf)).toThrow(/truncated|out of bounds/i);
    });

    test('rejects lump that extends past the buffer', () => {
        // Minimal valid-looking header: magic + version + 19 lump entries.
        const buf = Buffer.alloc(8 + 19 * 8);
        buf.writeUInt32LE(0x50534249, 0); // 'IBSP'
        buf.writeUInt32LE(38, 4);
        // Lump 0: ofs past end of the 160-byte buffer.
        buf.writeUInt32LE(200, 8);
        buf.writeUInt32LE(50, 12);
        expect(() => BspFile.load(buf)).toThrow(/out of bounds/);
    });
});

describe('BspFile — synthetic map', () => {
    const bsp = BspFile.load(buildSynthBsp());

    test('parses the header, models and face geometry', () => {
        expect(bsp.models).toHaveLength(1);
        expect(bsp.models[0].maxs).toEqual({ x: 64, y: 64, z: 16 });
        expect(bsp.faces).toHaveLength(1);
        expect(bsp.texinfo[0].name).toBe('test/synth');
    });

    test('getFacePolygon returns the quad in surfedge order', () => {
        const poly = bsp.getFacePolygon(0);
        expect(poly.map((v) => [v.x, v.y, v.z])).toEqual([
            [0, 0, 0], [64, 0, 0], [64, 64, 0], [0, 64, 0],
        ]);
    });

    test('getFaceNormal and texinfo follow the face references', () => {
        expect(bsp.getFaceNormal(0)).toEqual({ x: 0, y: 0, z: 1 });
        expect(bsp.texinfo[bsp.faces[0].texinfo].name).toBe('test/synth');
    });

    test('parseEntities reads the worldspawn', () => {
        const ents = bsp.parseEntities();
        expect(ents).toHaveLength(1);
        expect(ents[0].classname).toBe('worldspawn');
    });

    test('parseEntities does not throw on an empty entity lump', () => {
        const b = Buffer.from(buildSynthBsp());
        const headerSize = 8 + 19 * 8;
        b.writeUInt32LE(headerSize, 8);   // entities lump ofs → first data byte
        b.writeUInt32LE(1, 12);           // len = 1 (just NUL)
        b[headerSize] = 0;
        expect(BspFile.load(b).parseEntities()).toEqual([]);
    });
});
