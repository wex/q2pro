import { BufferReader } from './buffer.js';
import {
  SvcOps, PrintLevel,
  PS_M_TYPE, PS_M_ORIGIN, PS_M_VELOCITY, PS_M_TIME, PS_M_FLAGS,
  PS_M_GRAVITY, PS_M_DELTA_ANGLES, PS_VIEWOFFSET, PS_VIEWANGLES,
  PS_KICKANGLES, PS_BLEND, PS_FOV, PS_WEAPONINDEX, PS_WEAPONFRAME,
  PS_RDFLAGS,
  U_ORIGIN1, U_ORIGIN2, U_ANGLE2, U_ANGLE3, U_FRAME8, U_EVENT,
  U_REMOVE, U_MOREBITS1, U_NUMBER16, U_ORIGIN3, U_ANGLE1, U_MODEL,
  U_RENDERFX8, U_ANGLE16, U_EFFECTS8, U_MOREBITS2, U_SKIN8, U_FRAME16,
  U_RENDERFX16, U_EFFECTS16, U_MODEL2, U_MODEL3, U_MODEL4, U_MOREBITS3,
  U_OLDORIGIN, U_SKIN16, U_SOUND, U_SOLID,
  SND_VOLUME, SND_ATTENUATION, SND_POS, SND_ENT, SND_OFFSET, SND_INDEX16,
  MAX_CONFIGSTRINGS, MAX_ITEMS,
  type EntityState, type PlayerState, type ServerFrame,
  createDefaultEntityState, createDefaultPlayerState,
} from './protocol.js';

export interface ServerData {
  protocol: number;
  spawncount: number;
  gamedir: string;
  clientnum: number;
  levelname: string;
}

export interface ParseCallbacks {
  onServerData?: (data: ServerData) => void;
  onConfigString?: (index: number, value: string) => void;
  onSpawnBaseline?: (entity: EntityState) => void;
  onFrame?: (frame: ServerFrame) => void;
  onPrint?: (level: PrintLevel, text: string) => void;
  onStuffText?: (text: string) => void;
  onCenterPrint?: (text: string) => void;
  onDisconnect?: () => void;
  onReconnect?: () => void;
  onSound?: (info: SoundInfo) => void;
}

export interface SoundInfo {
  flags: number;
  index: number;
  volume: number;
  attenuation: number;
  offset: number;
  entity: number;
  channel: number;
  position: [number, number, number] | null;
}

/**
 * Parse delta-encoded entity state from the wire (protocol 34).
 */
export function parseDeltaEntity(reader: BufferReader, from: EntityState | null, number: number, bits: number): EntityState {
  const to: EntityState = from ? { ...from } : createDefaultEntityState();
  to.number = number;
  to.event = 0; // events are not delta'd

  if (bits & U_MODEL) {
    to.modelindex = reader.readByte();
  }
  if (bits & U_MODEL2) {
    to.modelindex2 = reader.readByte();
  }
  if (bits & U_MODEL3) {
    to.modelindex3 = reader.readByte();
  }
  if (bits & U_MODEL4) {
    to.modelindex4 = reader.readByte();
  }

  if (bits & U_FRAME8) {
    to.frame = reader.readByte();
  }
  if (bits & U_FRAME16) {
    to.frame = reader.readWord();
  }

  if ((bits & (U_SKIN8 | U_SKIN16)) === (U_SKIN8 | U_SKIN16)) {
    to.skinnum = reader.readLong();
  } else if (bits & U_SKIN8) {
    to.skinnum = reader.readByte();
  } else if (bits & U_SKIN16) {
    to.skinnum = reader.readWord();
  }

  if ((bits & (U_EFFECTS8 | U_EFFECTS16)) === (U_EFFECTS8 | U_EFFECTS16)) {
    to.effects = reader.readLong();
  } else if (bits & U_EFFECTS8) {
    to.effects = reader.readByte();
  } else if (bits & U_EFFECTS16) {
    to.effects = reader.readWord();
  }

  if ((bits & (U_RENDERFX8 | U_RENDERFX16)) === (U_RENDERFX8 | U_RENDERFX16)) {
    to.renderfx = reader.readLong();
  } else if (bits & U_RENDERFX8) {
    to.renderfx = reader.readByte();
  } else if (bits & U_RENDERFX16) {
    to.renderfx = reader.readWord();
  }

  if (bits & U_ORIGIN1) to.origin[0] = reader.readCoord();
  if (bits & U_ORIGIN2) to.origin[1] = reader.readCoord();
  if (bits & U_ORIGIN3) to.origin[2] = reader.readCoord();

  if (bits & U_ANGLE16) {
    if (bits & U_ANGLE1) to.angles[0] = reader.readAngle16();
    if (bits & U_ANGLE2) to.angles[1] = reader.readAngle16();
    if (bits & U_ANGLE3) to.angles[2] = reader.readAngle16();
  } else {
    if (bits & U_ANGLE1) to.angles[0] = reader.readAngle();
    if (bits & U_ANGLE2) to.angles[1] = reader.readAngle();
    if (bits & U_ANGLE3) to.angles[2] = reader.readAngle();
  }

  if (bits & U_OLDORIGIN) {
    to.oldorigin[0] = reader.readCoord();
    to.oldorigin[1] = reader.readCoord();
    to.oldorigin[2] = reader.readCoord();
  }

  if (bits & U_SOUND) to.sound = reader.readByte();
  if (bits & U_EVENT) to.event = reader.readByte();
  if (bits & U_SOLID) to.solid = reader.readWord();

  return to;
}

/**
 * Read entity bits and number from the wire.
 */
export function readEntityBitsAndNumber(reader: BufferReader): { bits: number; number: number } | null {
  let bits = reader.readByte();
  if (bits & U_MOREBITS1) {
    bits |= reader.readByte() << 8;
  }
  if (bits & U_MOREBITS2) {
    bits |= reader.readByte() << 16;
  }
  if (bits & U_MOREBITS3) {
    bits |= reader.readByte() << 24;
  }

  let number: number;
  if (bits & U_NUMBER16) {
    number = reader.readWord();
  } else {
    number = reader.readByte();
  }

  if (number === 0 && bits === 0) {
    return null; // end of entities
  }

  return { bits, number };
}

/**
 * Parse delta-encoded player state from the wire (protocol 34).
 */
export function parseDeltaPlayerState(reader: BufferReader, from: PlayerState | null): PlayerState {
  const to = from ? structuredClone(from) : createDefaultPlayerState();

  const flags = reader.readWord();

  // pmove_state_t
  if (flags & PS_M_TYPE) to.pmove.pm_type = reader.readByte();

  if (flags & PS_M_ORIGIN) {
    to.pmove.origin[0] = reader.readShort();
    to.pmove.origin[1] = reader.readShort();
    to.pmove.origin[2] = reader.readShort();
  }

  if (flags & PS_M_VELOCITY) {
    to.pmove.velocity[0] = reader.readShort();
    to.pmove.velocity[1] = reader.readShort();
    to.pmove.velocity[2] = reader.readShort();
  }

  if (flags & PS_M_TIME) to.pmove.pm_time = reader.readByte();
  if (flags & PS_M_FLAGS) to.pmove.pm_flags = reader.readByte();
  if (flags & PS_M_GRAVITY) to.pmove.gravity = reader.readShort();

  if (flags & PS_M_DELTA_ANGLES) {
    to.pmove.delta_angles[0] = reader.readShort();
    to.pmove.delta_angles[1] = reader.readShort();
    to.pmove.delta_angles[2] = reader.readShort();
  }

  // view state
  if (flags & PS_VIEWOFFSET) {
    to.viewoffset[0] = reader.readChar() * 0.25;
    to.viewoffset[1] = reader.readChar() * 0.25;
    to.viewoffset[2] = reader.readChar() * 0.25;
  }

  if (flags & PS_VIEWANGLES) {
    to.viewangles[0] = reader.readAngle16();
    to.viewangles[1] = reader.readAngle16();
    to.viewangles[2] = reader.readAngle16();
  }

  if (flags & PS_KICKANGLES) {
    to.kick_angles[0] = reader.readChar() * 0.25;
    to.kick_angles[1] = reader.readChar() * 0.25;
    to.kick_angles[2] = reader.readChar() * 0.25;
  }

  if (flags & PS_WEAPONINDEX) to.gunindex = reader.readByte();

  if (flags & PS_WEAPONFRAME) {
    to.gunframe = reader.readByte();
    to.gunoffset[0] = reader.readChar() * 0.25;
    to.gunoffset[1] = reader.readChar() * 0.25;
    to.gunoffset[2] = reader.readChar() * 0.25;
    to.gunangles[0] = reader.readChar() * 0.25;
    to.gunangles[1] = reader.readChar() * 0.25;
    to.gunangles[2] = reader.readChar() * 0.25;
  }

  if (flags & PS_BLEND) {
    to.blend[0] = reader.readByte() / 255.0;
    to.blend[1] = reader.readByte() / 255.0;
    to.blend[2] = reader.readByte() / 255.0;
    to.blend[3] = reader.readByte() / 255.0;
  }

  if (flags & PS_FOV) to.fov = reader.readByte();
  if (flags & PS_RDFLAGS) to.rdflags = reader.readByte();

  // stats — protocol 34 always sends all 32 stats as a bitmask + values
  const statbits = reader.readLong();
  for (let i = 0; i < 32; i++) {
    if (statbits & (1 << i)) {
      to.stats[i] = reader.readShort();
    }
  }

  return to;
}

/**
 * Parse all server messages from a packet payload.
 */
export function parseServerMessage(reader: BufferReader, callbacks: ParseCallbacks, baselines: Map<number, EntityState>, frames: ServerFrame[]): void {
  while (reader.remaining > 0) {
    const cmd = reader.readByte();
    if (cmd === -1) break;

    switch (cmd) {
      case SvcOps.ServerData:
        parseServerData(reader, callbacks);
        break;

      case SvcOps.ConfigString:
        parseConfigString(reader, callbacks);
        break;

      case SvcOps.SpawnBaseline:
        parseSpawnBaseline(reader, callbacks, baselines);
        break;

      case SvcOps.Frame:
        parseFrame(reader, callbacks, baselines, frames);
        break;

      case SvcOps.Print: {
        const level = reader.readByte() as PrintLevel;
        const text = reader.readString();
        callbacks.onPrint?.(level, text);
        break;
      }

      case SvcOps.StuffText: {
        const text = reader.readString();
        callbacks.onStuffText?.(text);
        break;
      }

      case SvcOps.CenterPrint: {
        const text = reader.readString();
        callbacks.onCenterPrint?.(text);
        break;
      }

      case SvcOps.Sound:
        parseSound(reader, callbacks);
        break;

      case SvcOps.Disconnect:
        callbacks.onDisconnect?.();
        return;

      case SvcOps.Reconnect:
        callbacks.onReconnect?.();
        return;

      case SvcOps.Nop:
        break;

      case SvcOps.MuzzleFlash:
      case SvcOps.MuzzleFlash2:
        reader.readShort(); // entity
        reader.readByte();  // effect
        break;

      case SvcOps.TempEntity:
        // temp entities are variable-length and game-specific; skip to end
        // For a complete implementation, each TE type needs specific parsing
        return;

      case SvcOps.Layout: {
        reader.readString(); // layout string
        break;
      }

      case SvcOps.Inventory: {
        for (let i = 0; i < MAX_ITEMS; i++) {
          reader.readShort();
        }
        break;
      }

      default:
        console.warn(`[parse] Unknown server command: ${cmd}`);
        return; // can't continue parsing without knowing the message size
    }
  }
}

function parseServerData(reader: BufferReader, callbacks: ParseCallbacks): void {
  const protocol = reader.readLong();
  const spawncount = reader.readLong();
  reader.readByte(); // attractloop
  const gamedir = reader.readString();
  const clientnum = reader.readShort();
  const levelname = reader.readString();

  callbacks.onServerData?.({ protocol, spawncount, gamedir, clientnum, levelname });
}

function parseConfigString(reader: BufferReader, callbacks: ParseCallbacks): void {
  const index = reader.readWord();
  const value = reader.readString();
  if (index < MAX_CONFIGSTRINGS) {
    callbacks.onConfigString?.(index, value);
  }
}

function parseSpawnBaseline(reader: BufferReader, callbacks: ParseCallbacks, baselines: Map<number, EntityState>): void {
  const result = readEntityBitsAndNumber(reader);
  if (!result) return;

  const entity = parseDeltaEntity(reader, null, result.number, result.bits);
  baselines.set(entity.number, entity);
  callbacks.onSpawnBaseline?.(entity);
}

function parseFrame(reader: BufferReader, callbacks: ParseCallbacks, baselines: Map<number, EntityState>, frames: ServerFrame[]): void {
  const framenum = reader.readLong();
  const deltaframe = reader.readLong();
  const suppressCount = reader.readByte();

  // areabits
  const areabytes = reader.readByte();
  const areabits = reader.readData(areabytes);

  // player state
  const playerInfoCmd = reader.readByte(); // should be svc_playerinfo (17)
  if (playerInfoCmd !== SvcOps.PlayerInfo) {
    console.warn(`[parse] Expected svc_playerinfo (17), got ${playerInfoCmd}`);
    return;
  }

  // find old player state from delta frame
  let oldPlayerState: PlayerState | null = null;
  if (deltaframe >= 0) {
    const oldFrame = frames.find(f => f.number === deltaframe);
    if (oldFrame) {
      oldPlayerState = oldFrame.playerstate;
    }
  }

  const playerstate = parseDeltaPlayerState(reader, oldPlayerState);

  // packet entities
  const packetEntitiesCmd = reader.readByte(); // should be svc_packetentities (18)
  if (packetEntitiesCmd !== SvcOps.PacketEntities) {
    console.warn(`[parse] Expected svc_packetentities (18), got ${packetEntitiesCmd}`);
    return;
  }

  // build old entity list from delta frame
  const oldEntities: Map<number, EntityState> = new Map();
  if (deltaframe >= 0) {
    const oldFrame = frames.find(f => f.number === deltaframe);
    if (oldFrame) {
      for (const ent of oldFrame.entities) {
        oldEntities.set(ent.number, ent);
      }
    }
  }

  const entities: EntityState[] = [];
  parsePacketEntities(reader, oldEntities, baselines, entities);

  const frame: ServerFrame = {
    number: framenum,
    delta: deltaframe,
    suppressCount,
    areabits,
    playerstate,
    entities,
  };

  // keep a ring buffer of recent frames
  frames.push(frame);
  if (frames.length > 16) {
    frames.shift();
  }

  callbacks.onFrame?.(frame);
}

function parsePacketEntities(reader: BufferReader, oldEntities: Map<number, EntityState>, baselines: Map<number, EntityState>, entities: EntityState[]): void {
  while (true) {
    const result = readEntityBitsAndNumber(reader);
    if (!result) break; // end marker (number=0, bits=0)

    const { bits, number } = result;

    if (bits & U_REMOVE) {
      // entity is removed; don't add to new list
      oldEntities.delete(number);
      continue;
    }

    // find the old entity state to delta from
    const old = oldEntities.get(number) ?? baselines.get(number) ?? null;
    const entity = parseDeltaEntity(reader, old, number, bits);
    entities.push(entity);
    oldEntities.delete(number);
  }

  // entities not mentioned in the delta remain unchanged
  for (const [, ent] of oldEntities) {
    entities.push({ ...ent, event: 0 });
  }
}

function parseSound(reader: BufferReader, callbacks: ParseCallbacks): void {
  const flags = reader.readByte();

  let index: number;
  if (flags & SND_INDEX16) {
    index = reader.readWord();
  } else {
    index = reader.readByte();
  }

  let volume = 1.0;
  if (flags & SND_VOLUME) volume = reader.readByte() / 255.0;

  let attenuation = 1.0;
  if (flags & SND_ATTENUATION) attenuation = reader.readByte() / 64.0;

  let offset = 0;
  if (flags & SND_OFFSET) offset = reader.readByte();

  let entity = 0;
  let channel = 0;
  if (flags & SND_ENT) {
    const val = reader.readWord();
    channel = val & 0x07;
    entity = val >> 3;
  }

  let position: [number, number, number] | null = null;
  if (flags & SND_POS) {
    position = [reader.readCoord(), reader.readCoord(), reader.readCoord()];
  }

  callbacks.onSound?.({ flags, index, volume, attenuation, offset, entity, channel, position });
}
