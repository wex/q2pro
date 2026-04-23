import { BufferReader } from './buffer';
import {
    MvdOp,
    MvdFlags,
    SVCMD_BITS,
    SVCMD_MASK,
    PROTOCOL_VERSION_MVD_EXTLIMITS,
    PROTOCOL_VERSION_MVD_EXTLIMITS2,
    PROTOCOL_VERSION_MVD_PLAYERFOG,
    PrintLevel,
    SvcOp,
    TempEntityType,
    Stat,
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
const SND_OFFSET = 1 << 4;
const SND_INDEX16 = 1 << 5;

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
    frags: number;
    /** Last-seen STAT_* values (indexed by stat number, 0-initialised). */
    stats: Int16Array;
}

export interface TeamScores {
    team1: number;
    team2: number;
    team3: number;
}

export interface FrameEvent {
    frameNumber: number;
    players: ReadonlyArray<Readonly<PlayerState>>;
    teamScores: TeamScores;
    layoutsFlags: number;
}

export interface ConfigStringEvent {
    index: number;
    value: string;
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

// ── New event payloads ─────────────────────────────────────────────

export interface PrintEvent {
    /** PRINT_LOW=0, PRINT_MEDIUM=1, PRINT_HIGH=2, PRINT_CHAT=3 */
    level: number;
    text: string;
    /** For unicast prints, the recipient client number. */
    clientNum?: number;
}

export interface ChatEvent {
    /** Speaker name, parsed from the leading "name: ..." portion when possible. */
    name: string;
    /** Chat body (without the "name: " prefix). */
    text: string;
    /** Full raw chat line (minus trailing newline). */
    raw: string;
}

export interface ObituaryEvent {
    victim: string;
    /** null for suicide / world-caused deaths. */
    attacker: string | null;
    /** Coarse weapon/mod token parsed from the template, or null. */
    weapon: string | null;
    raw: string;
}

export interface HitEvent {
    /** The player who dealt the hit (unicast recipient clientNum). */
    attacker: number;
    /** Parsed victim name from the print text. */
    victim: string;
    /** "head" | "chest" | "stomach" | "legs" | "body" | "" */
    location: string;
    raw: string;
}

export interface HitTakenEvent {
    /** The player who received the hit (unicast recipient clientNum). */
    victim: number;
    attacker: string;
    raw: string;
}

export interface LayoutEvent {
    clientNum: number;
    text: string;
}

export interface CenterPrintEvent {
    clientNum: number;
    text: string;
}

export interface TempEntityEvent {
    type: number;
    /** World-space position (undefined if not provided by the TE). */
    position?: [number, number, number];
    /** Second world-space position for two-point TEs (rail trail, BFG laser,
     *  hyperblaster trail, bubble trail). Represents the end/impact point
     *  while `position` is the start/muzzle point. */
    endPosition?: [number, number, number];
}

export interface StatsEvent {
    clientNum: number;
    stats: Int16Array;
}

export interface MuzzleFlashEvent {
    /** Shooter edict number (1..max_edicts). Player clientNum = entity - 1. */
    entity: number;
    /** MZ_* weapon flash id (see shared.h). Low 7 bits; the silenced bit is
     *  surfaced separately. */
    weapon: number;
    /** True for svc_muzzleflash (player flashes); false for svc_muzzleflash2
     *  (monster/entity flashes). */
    silenced: boolean;
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

    // Aggregated score state (updated via parseStats)
    private teamScores: TeamScores = { team1: 0, team2: 0, team3: 0 };
    private layoutsFlags = 0;
    private statsArrayLen = 32;

    // Chat dedup state: the Q2Pro MVD stream records one mvd_unicast_r per
    // recipient for every PF_cprintf(ent, PRINT_CHAT, ...) call, so a single
    // player saying one line arrives as N identical svc_print payloads within
    // the same server tick. We dedupe by (level,text) within a tick and reset
    // on the mvd_frame boundary. See doc/chat-dedup.md.
    private chatSeenThisTick: Set<string> = new Set();

    // Callbacks
    onFrame: ((event: FrameEvent) => void) | null = null;
    onServerData: ((event: ServerDataEvent) => void) | null = null;
    onConfigString: ((event: ConfigStringEvent) => void) | null = null;
    onPrint: ((event: PrintEvent) => void) | null = null;
    onChat: ((event: ChatEvent) => void) | null = null;
    onObituary: ((event: ObituaryEvent) => void) | null = null;
    onHit: ((event: HitEvent) => void) | null = null;
    onHitTaken: ((event: HitTakenEvent) => void) | null = null;
    onLayout: ((event: LayoutEvent) => void) | null = null;
    onCenterPrint: ((event: CenterPrintEvent) => void) | null = null;
    onTempEntity: ((event: TempEntityEvent) => void) | null = null;
    onStats: ((event: StatsEvent) => void) | null = null;
    onMuzzleFlash: ((event: MuzzleFlashEvent) => void) | null = null;

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
                    this.parseConfigString(reader);
                    break;
                case MvdOp.Unicast:
                case MvdOp.UnicastReliable:
                    this.parseUnicast(reader, extrabits);
                    break;
                case MvdOp.MulticastAll:
                case MvdOp.MulticastPhs:
                case MvdOp.MulticastPvs:
                case MvdOp.MulticastAllR:
                case MvdOp.MulticastPhsR:
                case MvdOp.MulticastPvsR:
                    this.parseMulticast(reader, cmd, extrabits);
                    break;
                case MvdOp.Sound:
                    this.skipSound(reader);
                    break;
                case MvdOp.Print:
                    this.parsePrint(reader);
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
        this.teamScores = { team1: 0, team2: 0, team3: 0 };
        this.layoutsFlags = 0;
        this.statsArrayLen = 32;
        this.chatSeenThisTick.clear();
    }

    private getOrCreatePlayerState(number: number): PlayerState {
        let ps = this.playerStates.get(number);
        if (ps) return ps;
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
            frags: 0,
            stats: new Int16Array(this.statsArrayLen),
        };
        this.playerStates.set(number, ps);
        return ps;
    }

    // ── ServerData ──────────────────────────────────────────────────

    private parseServerData(reader: BufferReader, extrabits: number): void {
        this.playerStates.clear();
        this.frameNumber = 0;
        this.chatSeenThisTick.clear();

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

        // Stats array length depends on protocol: 64 for extensions2, 32 otherwise
        this.statsArrayLen = (this.psFlags & MSG_PS_EXTENSIONS_2) ? 64 : 32;
        this.teamScores = { team1: 0, team2: 0, team3: 0 };
        this.layoutsFlags = 0;

        const servercount = reader.readInt32LE();
        const gamedir = reader.readString();
        const clientNum = reader.readInt16LE();

        // Parse configstrings
        const configstrings = new Map<number, string>();
        const csEnd = this.extended ? 13630 : 2080;
        while (reader.remaining >= 2) {
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
        // mvd_frame marks the end of a server tick. Any per-recipient unicast
        // chat duplicates were consolidated across the preceding unicast ops,
        // so clear the dedup set for the next tick.
        this.chatSeenThisTick.clear();

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
            teamScores: { ...this.teamScores },
            layoutsFlags: this.layoutsFlags,
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

            // Get or create player state
            const ps: PlayerState = this.getOrCreatePlayerState(number);

            // Apply deltas — must consume all delta bytes even for
            // PPS_REMOVE, since the wire format includes them.
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
                this.parseStats(reader, ps);
            }

            if (bits & PPS_REMOVE) {
                ps.inUse = false;
                continue;
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

    private parseConfigString(reader: BufferReader): void {
        const index = reader.readUInt16LE();
        const value = reader.readString();
        this.onConfigString?.({ index, value });
    }

    private parseUnicast(reader: BufferReader, extrabits: number): void {
        // length = byte | (extrabits << 8), then clientNum byte, then <length> bytes of data.
        // The clientNum byte is NOT part of the inner svc payload.
        let length = reader.readUInt8();
        length |= extrabits << 8;
        const clientNum = reader.readUInt8();
        const payload = reader.readBytes(length);

        try {
            this.parseInnerSvcMessages(new BufferReader(payload), clientNum);
        } catch {
            // Ignore inner parse errors — outer stream remains aligned because
            // we already consumed `length` bytes above.
        }
    }

    private parseMulticast(reader: BufferReader, cmd: number, extrabits: number): void {
        let length = reader.readUInt8();
        length |= extrabits << 8;

        const base = cmd >= MvdOp.MulticastAllR
            ? cmd - MvdOp.MulticastAllR
            : cmd - MvdOp.MulticastAll;

        // PHS and PVS variants include a leafnum which is part of the wire framing
        // but not part of the inner svc payload.
        if (base > 0) {
            reader.readUInt16LE(); // leafnum
        }

        const payload = reader.readBytes(length);
        try {
            this.parseInnerSvcMessages(new BufferReader(payload), -1);
        } catch {
            // ignored; see parseUnicast
        }
    }

    // ── Inner svc_ dispatch (inside Unicast/Multicast payloads) ─────

    private parseInnerSvcMessages(r: BufferReader, clientNum: number): void {
        while (r.remaining > 0) {
            const op = r.readUInt8();
            switch (op) {
                case SvcOp.Nop:
                    break;
                case SvcOp.Print: {
                    const level = r.readUInt8();
                    const text = r.readString();
                    this.emitPrint(level, text, clientNum >= 0 ? clientNum : undefined);
                    break;
                }
                case SvcOp.Layout: {
                    const text = r.readString();
                    if (clientNum >= 0) {
                        this.onLayout?.({ clientNum, text });
                    }
                    break;
                }
                case SvcOp.CenterPrint: {
                    const text = r.readString();
                    if (clientNum >= 0) {
                        this.onCenterPrint?.({ clientNum, text });
                    }
                    break;
                }
                case SvcOp.TempEntity:
                    if (!this.parseTempEntity(r)) return;
                    break;
                case SvcOp.MuzzleFlash:
                case SvcOp.MuzzleFlash2:
                    if (!this.parseMuzzleFlash(r, op === SvcOp.MuzzleFlash)) return;
                    break;
                case SvcOp.StuffText:
                    // [string] — swallow and continue; harmless for observers.
                    r.readString();
                    break;
                default:
                    // Unknown or variable-length op we can't walk safely: stop.
                    return;
            }
        }
    }

    private emitPrint(level: number, text: string, clientNum: number | undefined): void {
        this.onPrint?.({ level, text, clientNum });

        if (level === PrintLevel.Chat) {
            // Dedup per-recipient unicast chat duplicates within a single
            // server tick. The raw text (including any trailing newline) is
            // used as the signature so identical chat lines from different
            // speakers within the same tick are still distinct.
            const key = `${level}\x00${text}`;
            if (this.chatSeenThisTick.has(key)) {
                return;
            }
            this.chatSeenThisTick.add(key);

            const raw = text.replace(/\n+$/, '');
            const sep = raw.indexOf(': ');
            if (sep > 0) {
                this.onChat?.({ name: raw.slice(0, sep), text: raw.slice(sep + 2), raw });
            } else {
                this.onChat?.({ name: '', text: raw, raw });
            }
            return;
        }

        if (level === PrintLevel.Medium) {
            const ob = classifyObituary(text);
            if (ob) this.onObituary?.(ob);
            return;
        }

        if (level === PrintLevel.High && clientNum !== undefined) {
            const hit = classifyHit(text);
            if (hit) {
                this.onHit?.({ attacker: clientNum, victim: hit.victim, location: hit.location, raw: hit.raw });
                return;
            }
            const taken = classifyHitTaken(text);
            if (taken) {
                this.onHitTaken?.({ victim: clientNum, attacker: taken.attacker, raw: taken.raw });
            }
        }
    }

    // ── Muzzle-flash parsing ────────────────────────────────────────

    /**
     * `svc_muzzleflash` / `svc_muzzleflash2` carry `[entity u16][weapon u8]`.
     * For the non-silenced variant under the extended protocol, the upper
     * bits of `entity` are folded into `weapon` (see CL_ParseMuzzleFlashPacket
     * in src/client/parse.c). We mask back out here so `entity` is a clean
     * edict number. Returns false if the reader cannot supply 3 bytes.
     */
    private parseMuzzleFlash(r: BufferReader, isPlayerFlash: boolean): boolean {
        if (r.remaining < 3) return false;
        let entity = r.readUInt16LE();
        let weapon = r.readUInt8();
        if (!isPlayerFlash && this.extended) {
            weapon |= (entity >>> 13) << 8;
            entity &= 0x1fff;
        }
        const silenced = isPlayerFlash && (weapon & 0x80) !== 0;
        this.onMuzzleFlash?.({
            entity,
            weapon: weapon & 0x7f,
            silenced,
        });
        return true;
    }

    // ── Temp-entity parsing (enough to surface hit events) ──────────

    /** Returns false if parsing cannot safely continue on the inner reader. */
    private parseTempEntity(r: BufferReader): boolean {
        if (r.remaining < 1) return false;
        const type = r.readUInt8();

        // Types that carry [pos pos pos dir]
        const POS_DIR = [
            TempEntityType.Gunshot,
            TempEntityType.Blood,
            TempEntityType.Sparks,
            TempEntityType.BulletSparks,
            TempEntityType.ScreenSparks,
            TempEntityType.ShieldSparks,
            TempEntityType.Shotgun,
            TempEntityType.Blaster,
            TempEntityType.GreenBlood,
            TempEntityType.MoreBlood,
        ];

        // Types that carry [count pos pos pos dir color]
        const COUNT_POS_DIR_COLOR = [
            TempEntityType.Splash,
            TempEntityType.LaserSparks,
            TempEntityType.WeldingSparks,
            TempEntityType.TunnelSparks,
        ];

        // Types that carry just [pos]
        const POS_ONLY = [
            TempEntityType.GrenadeExpl,
            TempEntityType.GrenadeExplWat,
            TempEntityType.Explosion2,
            TempEntityType.PlasmaExpl,
            TempEntityType.RocketExpl,
            TempEntityType.RocketExplWat,
            TempEntityType.Explosion1,
            TempEntityType.BfgExplosion,
            TempEntityType.BfgBigExpl,
            TempEntityType.BossTport,
        ];

        // Types that carry [pos pos]
        const POS_POS = [
            TempEntityType.BlueHyper,
            TempEntityType.RailTrail,
            TempEntityType.BubbleTrail,
            TempEntityType.BfgLaser,
        ];

        try {
            if (POS_DIR.includes(type)) {
                const pos = this.readPos(r);
                r.readUInt8(); // dir
                this.onTempEntity?.({ type, position: pos });
                return true;
            }
            if (COUNT_POS_DIR_COLOR.includes(type)) {
                r.readUInt8(); // count
                const pos = this.readPos(r);
                r.readUInt8(); // dir
                r.readUInt8(); // color
                this.onTempEntity?.({ type, position: pos });
                return true;
            }
            if (POS_ONLY.includes(type)) {
                const pos = this.readPos(r);
                this.onTempEntity?.({ type, position: pos });
                return true;
            }
            if (POS_POS.includes(type)) {
                const pos = this.readPos(r);
                const endPos = this.readPos(r);
                this.onTempEntity?.({ type, position: pos, endPosition: endPos });
                return true;
            }
        } catch {
            return false;
        }

        // Unknown or variable-format TE — we can't walk past it safely.
        this.onTempEntity?.({ type });
        return false;
    }

    private readPos(r: BufferReader): [number, number, number] {
        const ext2 = !!(this.esFlags & MSG_ES_EXTENSIONS_2);
        const read1 = () => {
            if (ext2) {
                const v = r.readUInt16LE();
                if (v & 1) {
                    const full = (v | (r.readUInt8() << 16)) >>> 1;
                    return this.signExtend(full, 23) * (1 / 8);
                }
                return this.signExtend(v >>> 1, 15) * (1 / 8);
            }
            return r.readInt16LE() * (1 / 8);
        };
        return [read1(), read1(), read1()];
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

    private parsePrint(reader: BufferReader): void {
        const level = reader.readUInt8();
        const text = reader.readString();
        this.emitPrint(level, text, undefined);
    }

    private skipBlend(reader: BufferReader): void {
        if (this.psFlags & MSG_PS_EXTENSIONS_2) {
            const mask = reader.readUInt8();
            // blend[0..3] — bits 0..3
            if (mask & 1) reader.readUInt8();
            if (mask & 2) reader.readUInt8();
            if (mask & 4) reader.readUInt8();
            if (mask & 8) reader.readUInt8();
            // damage_blend[0..3] — bits 4..7
            if (mask & 16) reader.readUInt8();
            if (mask & 32) reader.readUInt8();
            if (mask & 64) reader.readUInt8();
            if (mask & 128) reader.readUInt8();
        } else {
            reader.readUInt8();
            reader.readUInt8();
            reader.readUInt8();
            reader.readUInt8();
        }
    }

    private skipFog(reader: BufferReader): void {
        const fogBits = reader.readUInt8();
        if (fogBits & 1) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); } // color
        if (fogBits & 2) { reader.readUInt16LE(); reader.readUInt16LE(); } // density + sky_factor
        if (fogBits & 4) reader.readUInt16LE(); // height density
        if (fogBits & 8) reader.readUInt16LE(); // height falloff
        if (fogBits & 16) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); } // height start color
        if (fogBits & 32) { reader.readUInt8(); reader.readUInt8(); reader.readUInt8(); } // height end color
        if (fogBits & 64) this.skipExtCoord(reader); // height start dist
        if (fogBits & 128) this.skipExtCoord(reader); // height end dist
    }

    private skipExtCoord(reader: BufferReader): void {
        const v = reader.readUInt16LE();
        if (v & 1) reader.readUInt8();
    }

    private parseStats(reader: BufferReader, ps: PlayerState): void {
        // Ensure the stat buffer matches the current protocol width.
        if (ps.stats.length !== this.statsArrayLen) {
            const grown = new Int16Array(this.statsArrayLen);
            grown.set(ps.stats.subarray(0, Math.min(ps.stats.length, this.statsArrayLen)));
            ps.stats = grown;
        }

        if (this.psFlags & MSG_PS_EXTENSIONS_2) {
            const statbits = reader.readVarInt64();
            for (let i = 0; i < 64; i++) {
                if (statbits & (1n << BigInt(i))) {
                    const v = reader.readInt16LE();
                    if (i < ps.stats.length) ps.stats[i] = v;
                    this.applyStat(i, v);
                }
            }
        } else {
            const statbits = reader.readUInt32LE() >>> 0;
            for (let i = 0; i < 32; i++) {
                if (statbits & (1 << i)) {
                    const v = reader.readInt16LE();
                    if (i < ps.stats.length) ps.stats[i] = v;
                    this.applyStat(i, v);
                }
            }
        }

        ps.frags = ps.stats[Stat.Frags] | 0;
        this.onStats?.({ clientNum: ps.number, stats: ps.stats });
    }

    private applyStat(index: number, value: number): void {
        switch (index) {
            case Stat.Team1Score: this.teamScores.team1 = value; break;
            case Stat.Team2Score: this.teamScores.team2 = value; break;
            case Stat.Team3Score: this.teamScores.team3 = value; break;
            case Stat.Layouts: this.layoutsFlags = value; break;
        }
    }

    // ── Coordinate conversion helpers ───────────────────────────────

    /** Convert raw pmove origin to world coordinates */
    static originToWorld(raw: [number, number, number]): [number, number, number] {
        return [raw[0] * 0.125, raw[1] * 0.125, raw[2] * 0.125];
    }
}

// ── Print-text classifiers (plain strings from game DLL) ─────────────

function stripTrailingNewline(s: string): string {
    return s.replace(/\n+$/, '');
}

/**
 * Parse a PRINT_HIGH line sent to the attacker. Examples (from AQ2/TNG):
 *   "You hit NAME in the head\n"
 *   "You hit NAME in the chest\n"
 *   "You hit NAME in the stomach\n"
 *   "You hit NAME in the legs\n"
 *   "You hit NAME in the body\n"
 *   "You hit your TEAMMATE NAME!\n"
 */
export function classifyHit(text: string): { victim: string; location: string; raw: string } | null {
    const raw = stripTrailingNewline(text);
    let m = raw.match(/^You hit (.+?) in the (head|chest|stomach|legs|body)\b/);
    if (m) return { victim: m[1], location: m[2], raw };
    m = raw.match(/^You hit your TEAMMATE (.+?)!/);
    if (m) return { victim: m[1], location: 'body', raw };
    m = raw.match(/^You hit (.+?)'s .* from /); // disarm
    if (m) return { victim: m[1], location: 'weapon', raw };
    // Kevlar helmet head shots (victim has a helmet). AQ2 emits these to the
    // attacker instead of "You hit X in the head" when the helmet absorbs.
    //   "NAME has a Kevlar Helmet, too bad you have AP rounds..." (sniper AP)
    //   "NAME has a Kevlar Helmet - AIM FOR THE BODY!"           (other bullets)
    m = raw.match(/^(.+?) has a Kevlar Helmet\b/);
    if (m) return { victim: m[1], location: 'head', raw };
    return null;
}

/**
 * Parse a PRINT_HIGH line sent to the victim:
 *   "You were hit by NAME, your TEAMMATE!\n"
 */
function classifyHitTaken(text: string): { attacker: string; raw: string } | null {
    const raw = stripTrailingNewline(text);
    const m = raw.match(/^You were hit by (.+?),/);
    if (m) return { attacker: m[1], raw };
    return null;
}

/**
 * Parse a PRINT_MEDIUM broadcast obituary. Matches the common templates used
 * by vanilla Q2 and AQ2/TNG `ClientObituary`. Output is best-effort.
 */
function classifyObituary(text: string): ObituaryEvent | null {
    const raw = stripTrailingNewline(text);

    // Suicides / world kills: "VICTIM killed himself", "VICTIM died."
    let m = raw.match(/^(.+?) killed (?:him|her|them|it)self\b/);
    if (m) return { victim: m[1], attacker: null, weapon: 'suicide', raw };

    m = raw.match(/^(.+?) tried to put the pin back in\b/);
    if (m) return { victim: m[1], attacker: null, weapon: 'grenade', raw };

    m = raw.match(/^(.+?) (?:fell|melted|does a back flip into the lava|cratered|blew up)\b/);
    if (m) return { victim: m[1], attacker: null, weapon: 'world', raw };

    // Canonical AQ2/TNG: "VICTIM was <verb> by ATTACKER's WEAPON"
    //   "was killed by", "was blown away by", "was shredded by", "was chopped up by"
    //   "got a hole through the head from", "was perforated by", etc.
    m = raw.match(/^(.+?) was (?:killed|blown away|shredded|chopped up|perforated|sniped|gunned down|brutalized) by (.+?)'s (.+?)\b[.!]?$/);
    if (m) return { victim: m[1], attacker: m[2], weapon: m[3], raw };

    m = raw.match(/^(.+?) was (?:killed|sniped|gunned down) by (.+?)\b[.!]?$/);
    if (m) return { victim: m[1], attacker: m[2], weapon: null, raw };

    // Vanilla Q2: "VICTIM was blasted by ATTACKER"
    m = raw.match(/^(.+?) was (?:blasted|railed|nailed|bolted|killed) by (.+?)$/);
    if (m) return { victim: m[1], attacker: m[2], weapon: null, raw };

    return null;
}

