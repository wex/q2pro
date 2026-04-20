import { BufferReader } from './buffer';
import {
    MvdOp,
    MvdFlags,
    SVCMD_BITS,
    SVCMD_MASK,
    PROTOCOL_VERSION_MVD_EXTLIMITS,
    PROTOCOL_VERSION_MVD_EXTLIMITS2,
    PROTOCOL_VERSION_MVD_PLAYERFOG,
} from './protocol';

// ── PPS bit flags (from inc/common/protocol.h) ─────────────────────

const PPS_M_TYPE = 1 << 0;
const PPS_M_ORIGIN = 1 << 1;
const PPS_M_ORIGIN2 = 1 << 2;
const PPS_VIEWOFFSET = 1 << 3;
const PPS_VIEWANGLES = 1 << 4;
const PPS_VIEWANGLE2 = 1 << 5;
const PPS_KICKANGLES = 1 << 6;
const PPS_BLEND = 1 << 7;
const PPS_FOV = 1 << 8;
const PPS_WEAPONINDEX = 1 << 9;
const PPS_WEAPONFRAME = 1 << 10;
const PPS_GUNOFFSET = 1 << 11;
const PPS_GUNANGLES = 1 << 12;
const PPS_RDFLAGS = 1 << 13;
const PPS_STATS = 1 << 14;
const PPS_MOREBITS = 1 << 15;
const PPS_REMOVE = 1 << 16;
const PPS_FOG = 1 << 17;

const CLIENTNUM_NONE = 255;

// ── U_ entity bit flags (from inc/common/protocol.h) ───────────────

const U_ORIGIN1 = 1 << 0;
const U_ORIGIN2 = 1 << 1;
const U_ANGLE2 = 1 << 2;
const U_ANGLE3 = 1 << 3;
const U_FRAME8 = 1 << 4;
const U_EVENT = 1 << 5;
const U_REMOVE = 1 << 6;
const U_MOREBITS1 = 1 << 7;
const U_NUMBER16 = 1 << 8;
const U_ORIGIN3 = 1 << 9;
const U_ANGLE1 = 1 << 10;
const U_MODEL = 1 << 11;
const U_RENDERFX8 = 1 << 12;
const U_ANGLE16 = 1 << 13;
const U_EFFECTS8 = 1 << 14;
const U_MOREBITS2 = 1 << 15;
const U_SKIN8 = 1 << 16;
const U_FRAME16 = 1 << 17;
const U_RENDERFX16 = 1 << 18;
const U_EFFECTS16 = 1 << 19;
const U_MODEL2 = 1 << 20;
const U_MODEL3 = 1 << 21;
const U_MODEL4 = 1 << 22;
const U_MOREBITS3 = 1 << 23;
const U_OLDORIGIN = 1 << 24;
const U_SKIN16 = 1 << 25;
const U_SOUND = 1 << 26;
const U_SOLID = 1 << 27;
const U_MODEL16 = 1 << 28;
const U_MOREFX8 = 1 << 29;
const U_ALPHA = 1 << 30;
const U_MOREBITS4 = 1 << 31;
// fifth byte (only with extensions)
const U_SCALE = 0x100000000;  // bit 32
const U_MOREFX16 = 0x200000000;  // bit 33

const U_SKIN32 = U_SKIN8 | U_SKIN16;
const U_EFFECTS32 = U_EFFECTS8 | U_EFFECTS16;
const U_RENDERFX32 = U_RENDERFX8 | U_RENDERFX16;
const U_MOREFX32 = U_MOREFX8 | U_MOREFX16;

// ── esFlags bits ────────────────────────────────────────────────────

const MSG_ES_EXTENSIONS = 1 << 5;
const MSG_ES_EXTENSIONS_2 = 1 << 9;
const MSG_ES_LONGSOLID = 1 << 3;
const MSG_ES_SHORTANGLES = 1 << 4;

// ── psFlags bits (from inc/common/msg.h) ────────────────────────────

const MSG_PS_EXTENSIONS = 1 << 4;
const MSG_PS_EXTENSIONS_2 = 1 << 5;
const MSG_PS_MOREBITS = 1 << 6;

// ── SND_ flags ──────────────────────────────────────────────────────

const SND_VOLUME = 1 << 0;
const SND_ATTENUATION = 1 << 1;
const SND_OFFSET = 1 << 3;
const SND_INDEX16 = 1 << 4;

// ── Public types ────────────────────────────────────────────────────

export interface PlayerState {
    number: number;
    inUse: boolean;
    pmType: number;
    origin: [number, number, number];
    viewangles: [number, number, number];
    viewoffset: [number, number, number];
    fov: number;
    gunindex: number;
    rdflags: number;
}

export interface FrameEvent {
    frameNumber: number;
    players: ReadonlyArray<Readonly<PlayerState>>;
}

export interface ServerDataEvent {
    protocol: number;
    version: number;
    flags: number;
    servercount: number;
    gamedir: string;
    clientNum: number;
    configstrings: Map<number, string>;
}

// ── Frame parser ────────────────────────────────────────────────────

export class MvdFrameParser {
    private playerStates: Map<number, PlayerState> = new Map();
    private frameNumber = 0;

    // Protocol state derived from serverdata
    private mvdVersion = 0;
    private mvdFlags = 0;
    private psFlags = 0;
    private esFlags = 0;
    private extended = false;

    // Callbacks
    onFrame: ((event: FrameEvent) => void) | null = null;
    onServerData: ((event: ServerDataEvent) => void) | null = null;

    /**
     * Feed a raw MVD stream data buffer (the payload from GTS_STREAM_DATA).
     * This walks all MVD commands and fires callbacks for frames and serverdata.
     */
    parse(data: Buffer): void {
        const reader = new BufferReader(data);

        while (reader.remaining > 0) {
            const cmdByte = reader.readUInt8();
            const extrabits = cmdByte >> SVCMD_BITS;
            const cmd = cmdByte & SVCMD_MASK;

            switch (cmd) {
                case MvdOp.ServerData:
                    this.parseServerData(reader, extrabits);
                    break;
                case MvdOp.Frame:
                    this.parseFrame(reader);
                    break;
                case MvdOp.ConfigString:
                    this.skipConfigString(reader);
                    break;
                case MvdOp.Unicast:
                case MvdOp.UnicastReliable:
                    this.skipUnicast(reader, extrabits);
                    break;
                case MvdOp.MulticastAll:
                case MvdOp.MulticastPhs:
                case MvdOp.MulticastPvs:
                case MvdOp.MulticastAllR:
                case MvdOp.MulticastPhsR:
                case MvdOp.MulticastPvsR:
                    this.skipMulticast(reader, cmd, extrabits);
                    break;
                case MvdOp.Sound:
                    this.skipSound(reader);
                    break;
                case MvdOp.Print:
                    this.skipPrint(reader);
                    break;
                case MvdOp.Nop:
                    break;
                default:
                    return;
            }
        }
    }

    /** Reset all accumulated state (e.g. on reconnect) */
    reset(): void {
        this.playerStates.clear();
        this.frameNumber = 0;
        this.mvdVersion = 0;
        this.mvdFlags = 0;
        this.psFlags = 0;
        this.esFlags = 0;
        this.extended = false;
    }

    // ── ServerData ──────────────────────────────────────────────────

    private parseServerData(reader: BufferReader, extrabits: number): void {
        this.playerStates.clear();
        this.frameNumber = 0;

        const protocol = reader.readInt32LE();
        const version = reader.readUInt16LE();
        this.mvdVersion = version;

        let flags = 0;
        if (version >= PROTOCOL_VERSION_MVD_EXTLIMITS2) {
            flags = reader.readUInt16LE();
        } else {
            flags = extrabits;
        }
        this.mvdFlags = flags;

        // Derive psFlags and esFlags from version and mvdFlags
        this.psFlags = 0;
        this.esFlags = 0;
        this.extended = false;

        if (version >= PROTOCOL_VERSION_MVD_EXTLIMITS && (flags & MvdFlags.ExtLimits)) {
            this.psFlags |= MSG_PS_EXTENSIONS;
            this.esFlags |= MSG_ES_EXTENSIONS | MSG_ES_LONGSOLID | MSG_ES_SHORTANGLES;
            this.extended = true;
        }
        if (version >= PROTOCOL_VERSION_MVD_EXTLIMITS2 && (flags & MvdFlags.ExtLimits2)) {
            this.psFlags |= MSG_PS_EXTENSIONS_2;
            this.esFlags |= MSG_ES_EXTENSIONS_2;
        }
        if (version >= PROTOCOL_VERSION_MVD_PLAYERFOG && (flags & MvdFlags.ExtLimits2)) {
            this.psFlags |= MSG_PS_MOREBITS;
        }

        const servercount = reader.readInt32LE();
        const gamedir = reader.readString();
        const clientNum = reader.readInt16LE();

        // Parse configstrings
        const configstrings = new Map<number, string>();
        const csEnd = this.extended ? 4928 : 2080;
        while (reader.remaining > 2) {
            const index = reader.readUInt16LE();
            if (index >= csEnd) break;
            const value = reader.readString();
            configstrings.set(index, value);
        }

        this.onServerData?.({
            protocol,
            version,
            flags,
            servercount,
            gamedir,
            clientNum,
            configstrings,
        });

        // Parse baseline frame (serverdata always includes an initial frame)
        this.parseFrame(reader);
    }

    // ── Frame ───────────────────────────────────────────────────────

    private parseFrame(reader: BufferReader): void {
        // Skip portalbits
        const portalLen = reader.readUInt8();
        reader.readBytes(portalLen);

        // Parse player states
        this.parsePacketPlayers(reader);

        // Skip entity states
        this.skipPacketEntities(reader);

        // Fire callback with current active players
        const activePlayers: PlayerState[] = [];
        for (const ps of this.playerStates.values()) {
            if (ps.inUse) {
                activePlayers.push({
                    ...ps,
                    origin: [...ps.origin],
                    viewangles: [...ps.viewangles],
                    viewoffset: [...ps.viewoffset],
                });
            }
        }

        this.onFrame?.({
            frameNumber: this.frameNumber,
            players: activePlayers,
        });

        this.frameNumber++;
    }

    // ── Player delta parsing ────────────────────────────────────────

    private parsePacketPlayers(reader: BufferReader): void {
        while (reader.remaining > 0) {
            const number = reader.readUInt8();
            if (number === CLIENTNUM_NONE) break;

            let bits = reader.readUInt16LE();
            if (bits & PPS_MOREBITS) {
                if (this.psFlags & MSG_PS_MOREBITS) {
                    bits |= reader.readUInt8() << 16;
                } else {
                    bits |= PPS_REMOVE;
                }
            }

            if (bits & PPS_REMOVE) {
                const existing = this.playerStates.get(number);
                if (existing) {
                    existing.inUse = false;
                }
                continue;
            }

            // Get or create player state
            let ps = this.playerStates.get(number);
            if (!ps) {
                ps = {
                    number,
                    inUse: false,
                    pmType: 0,
                    origin: [0, 0, 0],
                    viewangles: [0, 0, 0],
                    viewoffset: [0, 0, 0],
                    fov: 90,
                    gunindex: 0,
                    rdflags: 0,
                };
                this.playerStates.set(number, ps);
            }

            // Apply deltas
            if (bits & PPS_M_TYPE) {
                ps.pmType = reader.readUInt8();
            }

            if (this.psFlags & MSG_PS_EXTENSIONS_2) {
                if (bits & PPS_M_ORIGIN) {
                    ps.origin[0] = this.readDeltaInt23(reader, ps.origin[0]);
                    ps.origin[1] = this.readDeltaInt23(reader, ps.origin[1]);
                }
                if (bits & PPS_M_ORIGIN2) {
                    ps.origin[2] = this.readDeltaInt23(reader, ps.origin[2]);
                }
            } else {
                if (bits & PPS_M_ORIGIN) {
                    ps.origin[0] = reader.readInt16LE();
                    ps.origin[1] = reader.readInt16LE();
                }
                if (bits & PPS_M_ORIGIN2) {
                    ps.origin[2] = reader.readInt16LE();
                }
            }

            if (bits & PPS_VIEWOFFSET) {
                ps.viewoffset[0] = reader.readInt8() * 0.25;
                ps.viewoffset[1] = reader.readInt8() * 0.25;
                ps.viewoffset[2] = reader.readInt8() * 0.25;
            }

            if (bits & PPS_VIEWANGLES) {
                ps.viewangles[0] = reader.readInt16LE() * (360.0 / 65536);
                ps.viewangles[1] = reader.readInt16LE() * (360.0 / 65536);
            }

            if (bits & PPS_VIEWANGLE2) {
                ps.viewangles[2] = reader.readInt16LE() * (360.0 / 65536);
            }

            if (bits & PPS_KICKANGLES) {
                reader.readInt8();
                reader.readInt8();
                reader.readInt8();
            }

            if (bits & PPS_WEAPONINDEX) {
                if (this.psFlags & MSG_PS_EXTENSIONS) {
                    ps.gunindex = reader.readUInt16LE();
                } else {
                    ps.gunindex = reader.readUInt8();
                }
            }

            if (bits & PPS_WEAPONFRAME) {
                reader.readUInt8();
            }

            if (bits & PPS_GUNOFFSET) {
                reader.readInt8();
                reader.readInt8();
                reader.readInt8();
            }

            if (bits & PPS_GUNANGLES) {
                reader.readInt8();
                reader.readInt8();
                reader.readInt8();
            }

            if (bits & PPS_BLEND) {
                this.skipBlend(reader);
            }

            if (bits & PPS_FOG) {
                this.skipFog(reader);
            }

            if (bits & PPS_FOV) {
                ps.fov = reader.readUInt8();
            }

            if (bits & PPS_RDFLAGS) {
                ps.rdflags = reader.readUInt8();
            }

            if (bits & PPS_STATS) {
                this.skipStats(reader);
            }

            ps.inUse = true;
        }
    }

    // ── DeltaInt23 (from msg.c) ─────────────────────────────────────

    private readDeltaInt23(reader: BufferReader, current: number): number {
        const v = reader.readUInt16LE();
        if (v & 1) {
            const full = (v | (reader.readUInt8() << 16)) >>> 1;
            return this.signExtend(full, 23);
        } else {
            return current + this.signExtend(v >>> 1, 15);
        }
    }

    private signExtend(value: number, bits: number): number {
        const mask = 1 << (bits - 1);
        return (value ^ mask) - mask;
    }

    // ── Entity skipping ─────────────────────────────────────────────

    private skipPacketEntities(reader: BufferReader): void {
        while (reader.remaining > 0) {
            // Read entity bits using the same scheme as MSG_ParseEntityBits
            let bits = reader.readUInt8();
            if (bits & U_MOREBITS1) bits |= reader.readUInt8() << 8;
            if (bits & U_MOREBITS2) bits |= reader.readUInt8() << 16;
            if (bits & U_MOREBITS3) bits |= reader.readUInt8() << 24;
            // Fifth byte only with extensions
            // U_MOREBITS4 = bit 31 — but JS bitwise ops are 32-bit signed,
            // so (bits & U_MOREBITS4) needs care. Use >>> 0 to treat as unsigned.
            if ((this.esFlags & MSG_ES_EXTENSIONS) && ((bits >>> 0) & (U_MOREBITS4 >>> 0))) {
                // Can't use bitwise OR for bit 32+; use addition
                bits = (bits >>> 0) + (reader.readUInt8() * 0x100000000);
            }

            // Read entity number
            let number: number;
            if (bits & U_NUMBER16) {
                number = reader.readUInt16LE();
            } else {
                number = reader.readUInt8();
            }

            // number == 0 means end of entity list
            if (number === 0) break;

            // If this entity is being removed, no delta fields follow
            if (bits & U_REMOVE) continue;

            // Skip all delta fields
            this.skipEntityDelta(reader, bits);
        }
    }

    private skipEntityDelta(reader: BufferReader, bits: number): void {
        const hasExt = !!(this.esFlags & MSG_ES_EXTENSIONS);
        const hasExt2 = !!(this.esFlags & MSG_ES_EXTENSIONS_2);
        const hasLongSolid = !!(this.esFlags & MSG_ES_LONGSOLID);
        const hasShortAngles = !!(this.esFlags & MSG_ES_SHORTANGLES);

        // Models — must be read before frame in the C code,
        // but the actual wire order follows MSG_ParseDeltaEntity exactly.

        // Models (with U_MODEL16, models use uint16; otherwise uint8)
        const model16 = hasExt && (bits & U_MODEL16);
        if (bits & U_MODEL) { model16 ? reader.readUInt16LE() : reader.readUInt8(); }
        if (bits & U_MODEL2) { model16 ? reader.readUInt16LE() : reader.readUInt8(); }
        if (bits & U_MODEL3) { model16 ? reader.readUInt16LE() : reader.readUInt8(); }
        if (bits & U_MODEL4) { model16 ? reader.readUInt16LE() : reader.readUInt8(); }

        // Frame
        if (bits & U_FRAME8) reader.readUInt8();
        if (bits & U_FRAME16) reader.readUInt16LE();

        // Skin
        if ((bits & U_SKIN32) === U_SKIN32) reader.readInt32LE();
        else if (bits & U_SKIN8) reader.readUInt8();
        else if (bits & U_SKIN16) reader.readUInt16LE();

        // Effects
        if ((bits & U_EFFECTS32) === U_EFFECTS32) reader.readInt32LE();
        else if (bits & U_EFFECTS8) reader.readUInt8();
        else if (bits & U_EFFECTS16) reader.readUInt16LE();

        // Renderfx
        if ((bits & U_RENDERFX32) === U_RENDERFX32) reader.readInt32LE();
        else if (bits & U_RENDERFX8) reader.readUInt8();
        else if (bits & U_RENDERFX16) reader.readUInt16LE();

        // Origins
        if (hasExt2) {
            if (bits & U_ORIGIN1) this.skipDeltaCoord(reader);
            if (bits & U_ORIGIN2) this.skipDeltaCoord(reader);
            if (bits & U_ORIGIN3) this.skipDeltaCoord(reader);
        } else {
            if (bits & U_ORIGIN1) reader.readInt16LE(); // coord = short
            if (bits & U_ORIGIN2) reader.readInt16LE();
            if (bits & U_ORIGIN3) reader.readInt16LE();
        }

        // Angles
        if (hasShortAngles && (bits & U_ANGLE16)) {
            if (bits & U_ANGLE1) reader.readInt16LE();
            if (bits & U_ANGLE2) reader.readInt16LE();
            if (bits & U_ANGLE3) reader.readInt16LE();
        } else {
            if (bits & U_ANGLE1) reader.readInt8();
            if (bits & U_ANGLE2) reader.readInt8();
            if (bits & U_ANGLE3) reader.readInt8();
        }

        // Old origin (for beams)
        if (bits & U_OLDORIGIN) {
            if (hasExt2) {
                this.skipDeltaCoord(reader);
                this.skipDeltaCoord(reader);
                this.skipDeltaCoord(reader);
            } else {
                reader.readInt16LE();
                reader.readInt16LE();
                reader.readInt16LE();
            }
        }

        // Sound
        if (bits & U_SOUND) {
            if (hasExt) {
                const w = reader.readUInt16LE();
                if (w & 0x4000) reader.readUInt8(); // loop_volume
                if (w & 0x8000) reader.readUInt8(); // loop_attenuation
            } else {
                reader.readUInt8();
            }
        }

        // Event
        if (bits & U_EVENT) reader.readUInt8();

        // Solid
        if (bits & U_SOLID) {
            hasLongSolid ? reader.readInt32LE() : reader.readUInt16LE();
        }

        // Extensions (fifth-byte features)
        if (hasExt) {
            // morefx (U_MOREFX8=bit29, U_MOREFX16=bit33)
            // In JS we can't do 64-bit bitwise, but bit33 is stored in the
            // high part. For simplicity: check bit29 and the 5th-byte bit.
            const morefx8 = bits & U_MOREFX8;
            const morefx16 = (bits >= 0x200000000) ? !!(bits / 0x200000000 & 1) : false;
            if (morefx8 && morefx16) reader.readInt32LE();
            else if (morefx8) reader.readUInt8();
            else if (morefx16) reader.readUInt16LE();

            if (bits & U_ALPHA) reader.readUInt8();

            // U_SCALE = bit 32
            const hasScale = (bits >= 0x100000000) ? !!(bits / 0x100000000 & 1) : false;
            if (hasScale) reader.readUInt8();
        }
    }

    private skipDeltaCoord(reader: BufferReader): void {
        const v = reader.readUInt16LE();
        if (v & 1) reader.readUInt8(); // 3-byte absolute
        // else 2-byte delta — already consumed
    }

    // ── Skip helpers for non-player MVD commands ────────────────────

    private skipConfigString(reader: BufferReader): void {
        reader.readUInt16LE(); // index
        reader.readString();   // value
    }

    private skipUnicast(reader: BufferReader, extrabits: number): void {
        // length = byte | (extrabits << 8), then clientNum byte, then <length> bytes of data
        let length = reader.readUInt8();
        length |= extrabits << 8;
        reader.readUInt8(); // clientNum
        reader.readBytes(length);
    }

    private skipMulticast(reader: BufferReader, cmd: number, extrabits: number): void {
        // length = byte | (extrabits << 8)
        let length = reader.readUInt8();
        length |= extrabits << 8;

        // Compute the multicast type (0=ALL, 1=PHS, 2=PVS)
        const base = cmd >= MvdOp.MulticastAllR
            ? cmd - MvdOp.MulticastAllR
            : cmd - MvdOp.MulticastAll;

        // PHS and PVS variants include a leafnum
        if (base > 0) {
            reader.readUInt16LE(); // leafnum
        }

        reader.readBytes(length);
    }

    private skipSound(reader: BufferReader): void {
        // MVD sound format (from MVD_ParseSound in parse.c):
        // uint8 flags, [uint16|uint8] index, optional vol/atten/offset, uint16 sendchan
        const flags = reader.readUInt8();
        if (this.extended && (flags & SND_INDEX16)) {
            reader.readUInt16LE();
        } else {
            reader.readUInt8();
        }
        if (flags & SND_VOLUME) reader.readUInt8();
        if (flags & SND_ATTENUATION) reader.readUInt8();
        if (flags & SND_OFFSET) reader.readUInt8();
        reader.readUInt16LE(); // sendchan (entity+channel) — always present
    }

    private skipPrint(reader: BufferReader): void {
        reader.readUInt8(); // level
        reader.readString(); // message
    }

    private skipBlend(reader: BufferReader): void {
        if (this.psFlags & MSG_PS_EXTENSIONS_2) {
            const mask = reader.readUInt8();
            if (mask & 1) {
                reader.readUInt8();
                reader.readUInt8();
                reader.readUInt8();
                reader.readUInt8();
            }
            if (mask & 2) {
                reader.readUInt8();
                reader.readUInt8();
                reader.readUInt8();
                reader.readUInt8();
            }
        } else {
            reader.readUInt8();
            reader.readUInt8();
            reader.readUInt8();
            reader.readUInt8();
        }
    }

    private skipFog(reader: BufferReader): void {
        const fogBits = reader.readUInt8();
        if (fogBits & 1) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); }
        if (fogBits & 2) reader.readUInt16LE();
        if (fogBits & 4) reader.readUInt16LE();
        if (fogBits & 8) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); }
        if (fogBits & 16) reader.readUInt16LE();
        if (fogBits & 32) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); }
        if (fogBits & 64) reader.readUInt16LE();
        if (fogBits & 128) reader.readInt32LE();
    }

    private skipStats(reader: BufferReader): void {
        if (this.psFlags & MSG_PS_EXTENSIONS_2) {
            const lo = reader.readUInt32LE() >>> 0;
            const hi = reader.readUInt32LE() >>> 0;
            for (let i = 0; i < 32; i++) {
                if (lo & (1 << i)) reader.readInt16LE();
            }
            for (let i = 0; i < 32; i++) {
                if (hi & (1 << i)) reader.readInt16LE();
            }
        } else {
            const statbits = reader.readUInt32LE() >>> 0;
            for (let i = 0; i < 32; i++) {
                if (statbits & (1 << i)) reader.readInt16LE();
            }
        }
    }

    // ── Coordinate conversion helpers ───────────────────────────────

    /** Convert raw pmove origin to world coordinates */
    static originToWorld(raw: [number, number, number]): [number, number, number] {
        return [raw[0] * 0.125, raw[1] * 0.125, raw[2] * 0.125];
    }
}
