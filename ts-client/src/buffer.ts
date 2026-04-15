/**
 * Little-endian binary buffer reader for parsing server messages.
 */
export class BufferReader {
  private buf: Buffer;
  private pos: number;

  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.pos = offset;
  }

  get readCount(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  get length(): number {
    return this.buf.length;
  }

  get data(): Buffer {
    return this.buf;
  }

  readByte(): number {
    if (this.pos >= this.buf.length) return -1;
    return this.buf[this.pos++];
  }

  readChar(): number {
    const v = this.readByte();
    return v > 127 ? v - 256 : v;
  }

  readShort(): number {
    if (this.pos + 2 > this.buf.length) return -1;
    const v = this.buf.readInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readWord(): number {
    if (this.pos + 2 > this.buf.length) return 0;
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readLong(): number {
    if (this.pos + 4 > this.buf.length) return -1;
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readString(): string {
    let s = '';
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  readData(length: number): Buffer {
    const end = Math.min(this.pos + length, this.buf.length);
    const data = this.buf.subarray(this.pos, end);
    this.pos = end;
    return Buffer.from(data);
  }

  readCoord(): number {
    return this.readShort() * (1.0 / 8.0);
  }

  readAngle(): number {
    return this.readChar() * (360.0 / 256.0);
  }

  readAngle16(): number {
    return this.readShort() * (360.0 / 65536.0);
  }

  skip(n: number): void {
    this.pos += n;
  }

  seek(pos: number): void {
    this.pos = pos;
  }
}

/**
 * Little-endian binary buffer writer for building client messages.
 */
export class BufferWriter {
  private buf: Buffer;
  private pos: number;

  constructor(size = 4096) {
    this.buf = Buffer.alloc(size);
    this.pos = 0;
  }

  get cursize(): number {
    return this.pos;
  }

  get data(): Buffer {
    return this.buf.subarray(0, this.pos);
  }

  clear(): void {
    this.pos = 0;
  }

  writeByte(v: number): void {
    this.ensureSpace(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeChar(v: number): void {
    this.writeByte(v < 0 ? v + 256 : v);
  }

  writeShort(v: number): void {
    this.ensureSpace(2);
    this.buf.writeInt16LE(v, this.pos);
    this.pos += 2;
  }

  writeWord(v: number): void {
    this.ensureSpace(2);
    this.buf.writeUInt16LE(v & 0xffff, this.pos);
    this.pos += 2;
  }

  writeLong(v: number): void {
    this.ensureSpace(4);
    this.buf.writeInt32LE(v, this.pos);
    this.pos += 4;
  }

  writeString(s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.writeByte(s.charCodeAt(i));
    }
    this.writeByte(0);
  }

  writeData(data: Buffer): void {
    this.ensureSpace(data.length);
    data.copy(this.buf, this.pos);
    this.pos += data.length;
  }

  writeCoord(v: number): void {
    this.writeShort(Math.round(v * 8.0));
  }

  writeAngle(v: number): void {
    this.writeByte(Math.round(v * 256.0 / 360.0) & 0xff);
  }

  /** Get raw buffer reference at current position (for patching) */
  getPosition(): number {
    return this.pos;
  }

  patchByte(pos: number, v: number): void {
    this.buf[pos] = v & 0xff;
  }

  private ensureSpace(needed: number): void {
    if (this.pos + needed > this.buf.length) {
      const newBuf = Buffer.alloc(Math.max(this.buf.length * 2, this.pos + needed));
      this.buf.copy(newBuf);
      this.buf = newBuf;
    }
  }
}
