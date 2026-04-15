// Protocol version constants
export const PROTOCOL_VERSION_DEFAULT = 34;

// Max message/packet sizes
export const MAX_MSGLEN = 0x8000; // 32 KiB
export const MAX_PACKETLEN = 4096;
export const PACKET_HEADER = 10;
export const MIN_PACKETLEN = 512;
export const MAX_PACKETLEN_WRITABLE = MAX_PACKETLEN - PACKET_HEADER;
export const MAX_PACKETLEN_WRITABLE_DEFAULT = 1400 - PACKET_HEADER;

// Default ports
export const PORT_SERVER = 27910;

// Netchan constants
export const REL_BIT = 0x80000000;
export const OLD_MASK = REL_BIT - 1;

// Server-to-client opcodes
export enum SvcOps {
  Bad = 0,
  MuzzleFlash = 1,
  MuzzleFlash2 = 2,
  TempEntity = 3,
  Layout = 4,
  Inventory = 5,
  Nop = 6,
  Disconnect = 7,
  Reconnect = 8,
  Sound = 9,
  Print = 10,
  StuffText = 11,
  ServerData = 12,
  ConfigString = 13,
  SpawnBaseline = 14,
  CenterPrint = 15,
  Download = 16,
  PlayerInfo = 17,
  PacketEntities = 18,
  DeltaPacketEntities = 19,
  Frame = 20,
}

// Client-to-server opcodes
export enum ClcOps {
  Bad = 0,
  Nop = 1,
  Move = 2,
  UserInfo = 3,
  StringCmd = 4,
}

// Print levels
export enum PrintLevel {
  Low = 0,
  Medium = 1,
  High = 2,
  Chat = 3,
}

// Sound flags
export const SND_VOLUME = 1 << 0;
export const SND_ATTENUATION = 1 << 1;
export const SND_POS = 1 << 2;
export const SND_ENT = 1 << 3;
export const SND_OFFSET = 1 << 4;
export const SND_INDEX16 = 1 << 5;

// Entity state U_ flags
export const U_ORIGIN1 = 1 << 0;
export const U_ORIGIN2 = 1 << 1;
export const U_ANGLE2 = 1 << 2;
export const U_ANGLE3 = 1 << 3;
export const U_FRAME8 = 1 << 4;
export const U_EVENT = 1 << 5;
export const U_REMOVE = 1 << 6;
export const U_MOREBITS1 = 1 << 7;

export const U_NUMBER16 = 1 << 8;
export const U_ORIGIN3 = 1 << 9;
export const U_ANGLE1 = 1 << 10;
export const U_MODEL = 1 << 11;
export const U_RENDERFX8 = 1 << 12;
export const U_ANGLE16 = 1 << 13;
export const U_EFFECTS8 = 1 << 14;
export const U_MOREBITS2 = 1 << 15;

export const U_SKIN8 = 1 << 16;
export const U_FRAME16 = 1 << 17;
export const U_RENDERFX16 = 1 << 18;
export const U_EFFECTS16 = 1 << 19;
export const U_MODEL2 = 1 << 20;
export const U_MODEL3 = 1 << 21;
export const U_MODEL4 = 1 << 22;
export const U_MOREBITS3 = 1 << 23;

export const U_OLDORIGIN = 1 << 24;
export const U_SKIN16 = 1 << 25;
export const U_SOUND = 1 << 26;
export const U_SOLID = 1 << 27;

// Player state PS_ flags
export const PS_M_TYPE = 1 << 0;
export const PS_M_ORIGIN = 1 << 1;
export const PS_M_VELOCITY = 1 << 2;
export const PS_M_TIME = 1 << 3;
export const PS_M_FLAGS = 1 << 4;
export const PS_M_GRAVITY = 1 << 5;
export const PS_M_DELTA_ANGLES = 1 << 6;
export const PS_VIEWOFFSET = 1 << 7;
export const PS_VIEWANGLES = 1 << 8;
export const PS_KICKANGLES = 1 << 9;
export const PS_BLEND = 1 << 10;
export const PS_FOV = 1 << 11;
export const PS_WEAPONINDEX = 1 << 12;
export const PS_WEAPONFRAME = 1 << 13;
export const PS_RDFLAGS = 1 << 14;

// Usercmd CM_ flags
export const CM_ANGLE1 = 1 << 0;
export const CM_ANGLE2 = 1 << 1;
export const CM_ANGLE3 = 1 << 2;
export const CM_FORWARD = 1 << 3;
export const CM_SIDE = 1 << 4;
export const CM_UP = 1 << 5;
export const CM_BUTTONS = 1 << 6;
export const CM_IMPULSE = 1 << 7;

// Configstring layout (protocol 34)
export const MAX_CONFIGSTRINGS = 2080;
export const MAX_EDICTS = 1024;
export const MAX_MODELS = 256;
export const MAX_SOUNDS = 256;
export const MAX_IMAGES = 256;
export const MAX_CLIENTS = 256;
export const MAX_ITEMS = 256;
export const MAX_LIGHTSTYLES = 256;
export const MAX_GENERAL = MAX_CLIENTS * 2;

export const CS_NAME = 0;
export const CS_CDTRACK = 1;
export const CS_SKY = 2;
export const CS_SKYAXIS = 3;
export const CS_SKYROTATE = 4;
export const CS_STATUSBAR = 5;
export const CS_AIRACCEL = 29;
export const CS_MAXCLIENTS = 30;
export const CS_MAPCHECKSUM = 31;
export const CS_MODELS = 32;
export const CS_SOUNDS = CS_MODELS + MAX_MODELS;     // 288
export const CS_IMAGES = CS_SOUNDS + MAX_SOUNDS;     // 544
export const CS_LIGHTS = CS_IMAGES + MAX_IMAGES;     // 800
export const CS_ITEMS = CS_LIGHTS + MAX_LIGHTSTYLES;  // 1056
export const CS_PLAYERSKINS = CS_ITEMS + MAX_ITEMS;   // 1312
export const CS_GENERAL = CS_PLAYERSKINS + MAX_CLIENTS; // 1568

export const MAX_QPATH = 64;

// Update backup
export const UPDATE_BACKUP = 16;
export const UPDATE_MASK = UPDATE_BACKUP - 1;

export const CMD_BACKUP = 128;
export const CMD_MASK = CMD_BACKUP - 1;

// Connection states
export enum ConnState {
  Disconnected,
  Challenging,
  Connecting,
  Connected,
  Loading,
  Precached,
  Active,
}

// Data types for game state
export interface UserCmd {
  msec: number;
  buttons: number;
  angles: [number, number, number];
  forwardmove: number;
  sidemove: number;
  upmove: number;
  impulse: number;
  lightlevel: number;
}

export interface EntityState {
  number: number;
  origin: [number, number, number];
  angles: [number, number, number];
  oldorigin: [number, number, number];
  modelindex: number;
  modelindex2: number;
  modelindex3: number;
  modelindex4: number;
  frame: number;
  skinnum: number;
  effects: number;
  renderfx: number;
  solid: number;
  sound: number;
  event: number;
}

export interface PlayerState {
  pmove: {
    pm_type: number;
    origin: [number, number, number];
    velocity: [number, number, number];
    pm_flags: number;
    pm_time: number;
    gravity: number;
    delta_angles: [number, number, number];
  };
  viewoffset: [number, number, number];
  viewangles: [number, number, number];
  kick_angles: [number, number, number];
  gunindex: number;
  gunframe: number;
  gunoffset: [number, number, number];
  gunangles: [number, number, number];
  blend: [number, number, number, number];
  fov: number;
  rdflags: number;
  stats: number[];
}

export interface ServerFrame {
  number: number;
  delta: number;
  suppressCount: number;
  areabits: Buffer;
  playerstate: PlayerState;
  entities: EntityState[];
}

export function createDefaultEntityState(): EntityState {
  return {
    number: 0,
    origin: [0, 0, 0],
    angles: [0, 0, 0],
    oldorigin: [0, 0, 0],
    modelindex: 0,
    modelindex2: 0,
    modelindex3: 0,
    modelindex4: 0,
    frame: 0,
    skinnum: 0,
    effects: 0,
    renderfx: 0,
    solid: 0,
    sound: 0,
    event: 0,
  };
}

export function createDefaultPlayerState(): PlayerState {
  return {
    pmove: {
      pm_type: 0,
      origin: [0, 0, 0],
      velocity: [0, 0, 0],
      pm_flags: 0,
      pm_time: 0,
      gravity: 0,
      delta_angles: [0, 0, 0],
    },
    viewoffset: [0, 0, 0],
    viewangles: [0, 0, 0],
    kick_angles: [0, 0, 0],
    gunindex: 0,
    gunframe: 0,
    gunoffset: [0, 0, 0],
    gunangles: [0, 0, 0],
    blend: [0, 0, 0, 0],
    fov: 0,
    rdflags: 0,
    stats: new Array(32).fill(0),
  };
}

export function createDefaultUserCmd(): UserCmd {
  return {
    msec: 0,
    buttons: 0,
    angles: [0, 0, 0],
    forwardmove: 0,
    sidemove: 0,
    upmove: 0,
    impulse: 0,
    lightlevel: 0,
  };
}
