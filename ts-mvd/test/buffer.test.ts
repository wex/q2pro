import { BufferReader, BufferWriter } from '../src/buffer';

describe('BufferWriter / BufferReader', () => {
    test('UInt8 / Int8 roundtrip including negative Int8', () => {
        const w = new BufferWriter();
        w.writeUInt8(0).writeUInt8(255).writeUInt8(0x80);
        const r = new BufferReader(w.toBuffer());
        expect(r.readUInt8()).toBe(0);
        expect(r.readUInt8()).toBe(255);
        expect(r.readInt8()).toBe(-128);
    });

    test('UInt16LE / Int16LE / UInt32LE / Int32LE roundtrip', () => {
        const w = new BufferWriter();
        w.writeUInt16LE(0xbeef).writeInt16LE(-1).writeInt32LE(-123456).writeInt32LE(0x7fffffff);
        const r = new BufferReader(w.toBuffer());
        expect(r.readUInt16LE()).toBe(0xbeef);
        expect(r.readInt16LE()).toBe(-1);
        expect(r.readInt32LE()).toBe(-123456);
        expect(r.readInt32LE()).toBe(0x7fffffff);
        expect(r.remaining).toBe(0);
    });

    test('writeString / readString handles ASCII and empty strings with null terminators', () => {
        const w = new BufferWriter();
        w.writeString('hello').writeString('').writeString('world');
        const r = new BufferReader(w.toBuffer());
        expect(r.readString()).toBe('hello');
        expect(r.readString()).toBe('');
        expect(r.readString()).toBe('world');
    });

    test('readString returns "" at EOF without a null terminator', () => {
        const r = new BufferReader(Buffer.alloc(0));
        expect(r.readString()).toBe('');
    });

    test('readVarInt64 single-byte value', () => {
        const r = new BufferReader(Buffer.from([0x2a]));
        expect(r.readVarInt64()).toBe(42n);
    });

    test('readVarInt64 multi-byte value', () => {
        // 300 = 0b100101100 → bytes: 0xac, 0x02
        const r = new BufferReader(Buffer.from([0xac, 0x02]));
        expect(r.readVarInt64()).toBe(300n);
    });

    test('readVarInt64 stops after 64 bits even if continuation bit persists', () => {
        // Ten 0xff bytes followed by a byte with top bit clear; readVarInt64
        // must terminate at 63 bits so it never advances past the 10th byte.
        const bytes = Buffer.alloc(10, 0xff);
        const r = new BufferReader(bytes);
        // Should not throw; value is all-ones up to 63 bits consumed.
        r.readVarInt64();
        expect(r.position).toBeLessThanOrEqual(10);
    });

    test('readBytes slices and advances offset', () => {
        const src = Buffer.from([1, 2, 3, 4, 5]);
        const r = new BufferReader(src);
        r.readUInt8();
        expect(Array.from(r.readBytes(3))).toEqual([2, 3, 4]);
        expect(r.position).toBe(4);
        expect(r.remaining).toBe(1);
    });

    test('readRemaining returns the rest of the buffer', () => {
        const r = new BufferReader(Buffer.from([0xaa, 0xbb, 0xcc]));
        r.readUInt8();
        expect(Array.from(r.readRemaining())).toEqual([0xbb, 0xcc]);
        expect(r.remaining).toBe(0);
    });

    test('BufferWriter.reset clears accumulated bytes', () => {
        const w = new BufferWriter();
        w.writeInt32LE(0x12345678);
        w.reset();
        expect(w.length).toBe(0);
        w.writeUInt8(1);
        expect(w.toBuffer()).toEqual(Buffer.from([1]));
    });
});
