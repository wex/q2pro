// Binary read/write helpers for MVD/GTV wire format (little-endian)

export class BufferReader {
    private offset = 0;

    constructor(private buf: Buffer) { }

    get remaining(): number {
        return this.buf.length - this.offset;
    }

    get position(): number {
        return this.offset;
    }

    readUInt8(): number {
        const v = this.buf.readUInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readInt8(): number {
        const v = this.buf.readInt8(this.offset);
        this.offset += 1;
        return v;
    }

    readUInt16LE(): number {
        const v = this.buf.readUInt16LE(this.offset);
        this.offset += 2;
        return v;
    }

    readInt16LE(): number {
        const v = this.buf.readInt16LE(this.offset);
        this.offset += 2;
        return v;
    }

    readInt32LE(): number {
        const v = this.buf.readInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readUInt32LE(): number {
        const v = this.buf.readUInt32LE(this.offset);
        this.offset += 4;
        return v;
    }

    readVarInt64(): bigint {
        let v = 0n;
        let bits = 0;
        let c: number;
        do {
            c = this.readUInt8();
            v |= BigInt(c & 0x7f) << BigInt(bits);
            bits += 7;
        } while ((c & 0x80) && bits < 64);
        return v;
    }

    // Read a null-terminated string
    readString(): string {
        const start = this.offset;
        while (this.offset < this.buf.length && this.buf[this.offset] !== 0) {
            this.offset++;
        }
        const str = this.buf.toString('ascii', start, this.offset);
        if (this.offset < this.buf.length) {
            this.offset++; // skip null terminator
        }
        return str;
    }

    // Read N bytes as a new Buffer
    readBytes(n: number): Buffer {
        const slice = this.buf.subarray(this.offset, this.offset + n);
        this.offset += n;
        return slice;
    }

    // Read all remaining bytes
    readRemaining(): Buffer {
        return this.readBytes(this.remaining);
    }
}

export class BufferWriter {
    private parts: Buffer[] = [];
    private totalLength = 0;

    get length(): number {
        return this.totalLength;
    }

    writeUInt8(v: number): this {
        const b = Buffer.allocUnsafe(1);
        b.writeUInt8(v);
        this.parts.push(b);
        this.totalLength += 1;
        return this;
    }

    writeUInt16LE(v: number): this {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16LE(v);
        this.parts.push(b);
        this.totalLength += 2;
        return this;
    }

    writeInt16LE(v: number): this {
        const b = Buffer.allocUnsafe(2);
        b.writeInt16LE(v);
        this.parts.push(b);
        this.totalLength += 2;
        return this;
    }

    writeInt32LE(v: number): this {
        const b = Buffer.allocUnsafe(4);
        b.writeInt32LE(v);
        this.parts.push(b);
        this.totalLength += 4;
        return this;
    }

    // Write a null-terminated string
    writeString(s: string): this {
        const b = Buffer.alloc(s.length + 1);
        b.write(s, 'ascii');
        // last byte is already 0 from alloc
        this.parts.push(b);
        this.totalLength += b.length;
        return this;
    }

    writeBytes(data: Buffer): this {
        this.parts.push(data);
        this.totalLength += data.length;
        return this;
    }

    toBuffer(): Buffer {
        return Buffer.concat(this.parts, this.totalLength);
    }

    reset(): void {
        this.parts = [];
        this.totalLength = 0;
    }
}
