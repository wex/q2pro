import dgram from 'node:dgram';
import { BufferReader, BufferWriter } from './buffer.js';
import {
  PROTOCOL_VERSION_DEFAULT,
  REL_BIT,
  OLD_MASK,
  MAX_PACKETLEN_WRITABLE_DEFAULT,
} from './protocol.js';

/**
 * NETCHAN_OLD implementation for protocol 34.
 * Handles sequenced, optionally reliable datagram delivery over UDP.
 */
export class Netchan {
  sock: dgram.Socket;
  remoteAddress: string;
  remotePort: number;
  qport: number;
  protocol: number;
  maxpacketlen: number;

  // sequencing
  outgoingSequence = 1;
  incomingSequence = 0;
  incomingAcknowledged = 0;

  // reliable messaging
  reliableSequence = false;       // single bit: current reliable sequence
  incomingReliableAcknowledged = false; // single bit: last ack'd reliable
  incomingReliableSequence = false;     // single bit: last received reliable
  lastReliableSequence = 0;

  reliableBuf: Buffer = Buffer.alloc(0);  // unacked reliable data
  reliableLength = 0;
  message: BufferWriter;                  // pending reliable data

  dropped = 0;
  lastReceived = Date.now();
  lastSent = Date.now();

  constructor(
    sock: dgram.Socket,
    address: string,
    port: number,
    qport: number,
    protocol = PROTOCOL_VERSION_DEFAULT,
    maxpacketlen = MAX_PACKETLEN_WRITABLE_DEFAULT,
  ) {
    this.sock = sock;
    this.remoteAddress = address;
    this.remotePort = port;
    this.qport = qport;
    this.protocol = protocol;
    this.maxpacketlen = maxpacketlen;
    this.message = new BufferWriter(maxpacketlen);
    this.reliableBuf = Buffer.alloc(maxpacketlen);
  }

  /**
   * Transmit a packet with optional unreliable data.
   * Reliable data from this.message is sent first if pending.
   */
  transmit(unreliableData?: Buffer): void {
    let sendReliable = false;

    // if the remote side dropped the last reliable message, resend it
    if (
      this.incomingAcknowledged > this.lastReliableSequence &&
      this.incomingReliableAcknowledged !== this.reliableSequence
    ) {
      sendReliable = true;
    }

    // if the reliable transmit buffer is empty, copy the current message out
    if (this.reliableLength === 0 && this.message.cursize > 0) {
      sendReliable = true;
      const msgData = this.message.data;
      msgData.copy(this.reliableBuf, 0, 0, msgData.length);
      this.reliableLength = msgData.length;
      this.message.clear();
      this.reliableSequence = !this.reliableSequence;
    }

    // write packet header
    const writer = new BufferWriter(this.maxpacketlen + 20);

    // sequence word: bits 0-30 = sequence, bit 31 = reliable flag
    let w1 = this.outgoingSequence & OLD_MASK;
    if (sendReliable) {
      w1 |= REL_BIT;
    }
    // convert to signed 32-bit for writeLong
    writer.writeLong(w1 | 0);

    // ack word: bits 0-30 = incoming sequence, bit 31 = incoming reliable sequence
    let w2 = this.incomingSequence & OLD_MASK;
    if (this.incomingReliableSequence) {
      w2 |= REL_BIT;
    }
    writer.writeLong(w2 | 0);

    // protocol 34: 16-bit qport from client (unsigned)
    writer.writeWord(this.qport & 0xffff);

    // copy reliable data first
    if (sendReliable) {
      writer.writeData(this.reliableBuf.subarray(0, this.reliableLength));
      this.lastReliableSequence = this.outgoingSequence;
    }

    // add unreliable data
    if (unreliableData && unreliableData.length > 0) {
      writer.writeData(unreliableData);
    }

    // send
    const packet = writer.data;
    this.sock.send(packet, 0, packet.length, this.remotePort, this.remoteAddress);

    this.outgoingSequence++;
    this.lastSent = Date.now();
  }

  /**
   * Process an incoming sequenced packet.
   * Returns a BufferReader positioned at the payload, or null if the packet should be dropped.
   */
  process(data: Buffer): BufferReader | null {
    const reader = new BufferReader(data);

    const sequenceRaw = reader.readLong();
    const sequenceAckRaw = reader.readLong();

    // server doesn't read qport from server→client packets

    const reliableMessage = !!(sequenceRaw & REL_BIT);
    const reliableAck = !!(sequenceAckRaw & REL_BIT);

    const sequence = (sequenceRaw & OLD_MASK) >>> 0;
    const sequenceAck = (sequenceAckRaw & OLD_MASK) >>> 0;

    // discard stale or duplicated packets
    if (sequence <= this.incomingSequence) {
      return null;
    }

    // detect dropped packets
    this.dropped = sequence - (this.incomingSequence + 1);

    // if the current outgoing reliable message has been acknowledged, clear it
    this.incomingReliableAcknowledged = reliableAck;
    if (reliableAck === this.reliableSequence) {
      this.reliableLength = 0;
    }

    // if this message contains a reliable message, bump incoming_reliable_sequence
    this.incomingSequence = sequence;
    this.incomingAcknowledged = sequenceAck;
    if (reliableMessage) {
      this.incomingReliableSequence = !this.incomingReliableSequence;
    }

    this.lastReceived = Date.now();
    return reader;
  }
}

/**
 * Send an out-of-band (connectionless) packet.
 * Format: 0xFFFFFFFF + text
 */
export function sendOOB(sock: dgram.Socket, address: string, port: number, text: string): void {
  const header = Buffer.alloc(4, 0xff);
  const payload = Buffer.from(text, 'ascii');
  const packet = Buffer.concat([header, payload]);
  sock.send(packet, 0, packet.length, port, address);
}

/**
 * Check if a packet is an out-of-band packet (starts with 0xFFFFFFFF).
 */
export function isOOBPacket(data: Buffer): boolean {
  return data.length >= 4 &&
    data[0] === 0xff && data[1] === 0xff &&
    data[2] === 0xff && data[3] === 0xff;
}

/**
 * Parse the text payload from an OOB packet (skip the 4-byte header).
 */
export function parseOOBPayload(data: Buffer): string {
  return data.subarray(4).toString('ascii');
}
