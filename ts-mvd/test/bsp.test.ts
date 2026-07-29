import { BspFile } from '../src/bsp';

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
