// MVD/GTV Protocol constants and enums

// 'MVD2' as a 32-bit little-endian value: 0x3244564D
export const MVD_MAGIC = Buffer.from('MVD2', 'ascii');

// GTV protocol version
export const GTV_PROTOCOL_VERSION = 0xed04;

// Maximum message lengths
export const MAX_GTS_MSGLEN = 0x8000; // 32 KiB — max server message
export const MAX_GTC_MSGLEN = 256;    // max client message

// Negotiation flags (used in hello packet)
export const GTF_DEFLATE = 1;
export const GTF_STRINGCMDS = 2;

// Server-to-client opcodes
export enum GtvServerOp {
    Hello = 0,
    Pong = 1,
    StreamStart = 2,
    StreamStop = 3,
    StreamData = 4,
    Error = 5,
    BadRequest = 6,
    NoAccess = 7,
    Disconnect = 8,
    Reconnect = 9,
}

// Client-to-server opcodes
export enum GtvClientOp {
    Hello = 0,
    Ping = 1,
    StreamStart = 2,
    StreamStop = 3,
    StringCmd = 4,
}

// MVD stream command opcodes (inside GTS_STREAM_DATA payloads)
export enum MvdOp {
    Bad = 0,
    Nop = 1,
    Disconnect = 2,  // reserved
    Reconnect = 3,  // reserved
    ServerData = 4,
    ConfigString = 5,
    Frame = 6,
    FrameNoDelta = 7,  // reserved
    Unicast = 8,
    UnicastReliable = 9,
    MulticastAll = 10,
    MulticastPhs = 11,
    MulticastPvs = 12,
    MulticastAllR = 13,
    MulticastPhsR = 14,
    MulticastPvsR = 15,
    Sound = 16,
    Print = 17,
    StuffText = 18, // reserved
}

export const SVCMD_BITS = 5;
export const SVCMD_MASK = (1 << SVCMD_BITS) - 1;

// MVD stream flags
export enum MvdFlags {
    NoMsgs = 1 << 0,
    SinglePov = 1 << 1,
    ExtLimits = 1 << 2,
    ExtLimits2 = 1 << 3,
}

// MVD protocol versions
export const PROTOCOL_VERSION_MVD = 37;
export const PROTOCOL_VERSION_MVD_MINIMUM = 2009;
export const PROTOCOL_VERSION_MVD_DEFAULT = 2010;
export const PROTOCOL_VERSION_MVD_EXTLIMITS = 2011;
export const PROTOCOL_VERSION_MVD_EXTLIMITS2 = 2012;
export const PROTOCOL_VERSION_MVD_PLAYERFOG = 2013;
export const PROTOCOL_VERSION_MVD_CURRENT = 2013;

// Game print levels (shared/shared.h: PRINT_LOW .. PRINT_CHAT)
export enum PrintLevel {
    Low = 0,  // pickup messages
    Medium = 1,  // death messages
    High = 2,  // critical / per-player info (hits, etc.)
    Chat = 3,  // chat messages
}

// svc_ops_t — only the ones we care to decode inside unicast/multicast payloads
export enum SvcOp {
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
}

// temp_entity event types (subset used for hit detection, matching inc/shared/shared.h)
export enum TempEntityType {
    Gunshot = 0,
    Blood = 1,
    Blaster = 2,
    RailTrail = 3,
    Shotgun = 4,
    Explosion1 = 5,
    Explosion2 = 6,
    RocketExpl = 7,
    GrenadeExpl = 8,
    Sparks = 9,
    Splash = 10,
    BubbleTrail = 11,
    ScreenSparks = 12,
    ShieldSparks = 13,
    BulletSparks = 14,
    LaserSparks = 15,
    ParasiteAtk = 16,
    RocketExplWat = 17,
    GrenadeExplWat = 18,
    MedicCableAtk = 19,
    BfgExplosion = 20,
    BfgBigExpl = 21,
    BossTport = 22,
    BfgLaser = 23,
    GrappleCable = 24,
    WeldingSparks = 25,
    GreenBlood = 26,
    BlueHyper = 27,
    PlasmaExpl = 28,
    TunnelSparks = 29,
    MoreBlood = 42,
}

// player_state stat indices we surface explicitly
export enum Stat {
    Layouts = 13,
    Frags = 14,
    Team1Score = 25,
    Team2Score = 26,
    Team3Score = 30,
}

// Client connection states
export enum ClientState {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Preparing = 'preparing',
    Ready = 'ready',
    Streaming = 'streaming',
    Suspended = 'suspended',
}
