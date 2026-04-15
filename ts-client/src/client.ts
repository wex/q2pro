import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { BufferWriter } from './buffer.js';
import { blockSequenceCRCByte } from './crc.js';
import { Netchan, sendOOB, isOOBPacket, parseOOBPayload } from './netchan.js';
import {
  parseServerMessage, parseDeltaPlayerState,
  type ParseCallbacks, type ServerData,
} from './parse.js';
import {
  PROTOCOL_VERSION_DEFAULT, PORT_SERVER,
  ConnState, ClcOps, PrintLevel,
  CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP,
  CM_BUTTONS, CM_IMPULSE,
  type EntityState, type PlayerState, type ServerFrame, type UserCmd,
  createDefaultUserCmd, createDefaultPlayerState,
} from './protocol.js';

const CONNECT_DELAY = 3000;
const TIMEOUT = 90000;
const KEEPALIVE_INTERVAL = 5000;

export interface Q2ClientOptions {
  host: string;
  port?: number;
  name?: string;
  skin?: string;
  fov?: number;
}

export class Q2Client extends EventEmitter {
  private host: string;
  private port: number;
  private name: string;
  private skin: string;
  private fov: number;

  private sock: dgram.Socket | null = null;
  private netchan: Netchan | null = null;
  private state = ConnState.Disconnected;
  private challenge = 0;
  private qport: number;

  // game state
  private spawncount = 0;
  private clientnum = -1;
  private gamedir = '';
  private levelname = '';
  private configstrings: Map<number, string> = new Map();
  private baselines: Map<number, EntityState> = new Map();
  private frames: ServerFrame[] = [];
  private playerstate: PlayerState = createDefaultPlayerState();
  private lastFrame = -1;

  // timing
  private connectTime = 0;
  private connectCount = 0;
  private lastMessageTime = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private thinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Q2ClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? PORT_SERVER;
    this.name = options.name ?? 'TSClient';
    this.skin = options.skin ?? 'male/grunt';
    this.fov = options.fov ?? 90;
    this.qport = (Date.now() & 0xffff);
  }

  get connectionState(): ConnState {
    return this.state;
  }

  get currentMap(): string {
    return this.levelname;
  }

  get currentPlayerState(): PlayerState {
    return this.playerstate;
  }

  /**
   * Begin connecting to the server.
   */
  connect(): void {
    if (this.state !== ConnState.Disconnected) {
      this.disconnect();
    }

    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg) => this.onPacket(msg));
    this.sock.on('error', (err) => {
      this.emit('error', err);
      this.disconnect();
    });

    this.sock.bind(0, () => {
      this.state = ConnState.Challenging;
      this.connectTime = 0;
      this.connectCount = 0;
      this.lastMessageTime = Date.now();
      this.emit('log', `Connecting to ${this.host}:${this.port}...`);
      this.sendChallenge();

      // periodic think loop
      this.thinkTimer = setInterval(() => this.think(), 100);
    });
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.netchan && this.state >= ConnState.Connected) {
      // send disconnect command
      this.sendStringCmd('disconnect');
      this.netchan.transmit();
    }

    this.cleanup();
    this.state = ConnState.Disconnected;
    this.emit('disconnect');
  }

  /**
   * Send a chat message.
   */
  say(message: string): void {
    this.sendStringCmd(`say ${message}`);
  }

  /**
   * Send an arbitrary command string to the server.
   */
  sendCommand(cmd: string): void {
    this.sendStringCmd(cmd);
  }

  // ------ Private ------

  private cleanup(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.thinkTimer) {
      clearInterval(this.thinkTimer);
      this.thinkTimer = null;
    }
    if (this.sock) {
      try { this.sock.close(); } catch { }
      this.sock = null;
    }
    this.netchan = null;
    this.configstrings.clear();
    this.baselines.clear();
    this.frames = [];
    this.lastFrame = -1;
  }

  private think(): void {
    const now = Date.now();

    // timeout check
    if (this.state >= ConnState.Connected && now - this.lastMessageTime > TIMEOUT) {
      this.emit('log', 'Connection timed out');
      this.disconnect();
      return;
    }

    // resend challenge/connect
    if (this.state === ConnState.Challenging || this.state === ConnState.Connecting) {
      if (now - this.connectTime >= CONNECT_DELAY) {
        this.connectTime = now;
        this.connectCount++;
        if (this.connectCount > 10) {
          this.emit('log', 'Connection failed after 10 retries');
          this.disconnect();
          return;
        }
        if (this.state === ConnState.Challenging) {
          this.sendChallenge();
        } else {
          this.sendConnect();
        }
      }
      return;
    }

    // send keepalive move packets when active
    if (this.state === ConnState.Active && this.netchan) {
      this.sendMovePacket();
    }
  }

  private sendChallenge(): void {
    if (!this.sock) return;
    this.emit('log', `Requesting challenge... ${this.connectCount}`);
    sendOOB(this.sock, this.host, this.port, 'getchallenge\n');
  }

  private sendConnect(): void {
    if (!this.sock) return;
    const userinfo = this.buildUserinfo();
    this.emit('log', `Requesting connection... ${this.connectCount}`);
    sendOOB(
      this.sock, this.host, this.port,
      `connect ${PROTOCOL_VERSION_DEFAULT} ${this.qport} ${this.challenge} "${userinfo}"\n`,
    );
  }

  private buildUserinfo(): string {
    return `\\name\\${this.name}\\skin\\${this.skin}\\fov\\${this.fov}\\hand\\2`;
  }

  private sendStringCmd(cmd: string): void {
    if (!this.netchan) return;
    this.netchan.message.writeByte(ClcOps.StringCmd);
    this.netchan.message.writeString(cmd);
  }

  private sendMovePacket(): void {
    if (!this.netchan) return;

    const writer = new BufferWriter(256);
    writer.writeByte(ClcOps.Move);

    // checksum placeholder position
    const checksumIndex = writer.cursize;
    writer.writeByte(0); // placeholder

    // last frame
    writer.writeLong(this.lastFrame);

    // write 3 empty usercmds (oldest, old, new) — delta from null
    const nullCmd = createDefaultUserCmd();
    for (let i = 0; i < 3; i++) {
      this.writeDeltaUsercmd(writer, nullCmd, nullCmd);
      writer.writeByte(0); // lightlevel
    }

    // compute checksum
    const data = writer.data;
    const checksum = blockSequenceCRCByte(
      data,
      checksumIndex + 1,
      data.length - checksumIndex - 1,
      this.netchan.outgoingSequence,
    );
    writer.patchByte(checksumIndex, checksum);

    // send as unreliable
    this.netchan.transmit(writer.data);
  }

  private writeDeltaUsercmd(writer: BufferWriter, from: UserCmd, to: UserCmd): void {
    let bits = 0;
    if (to.angles[0] !== from.angles[0]) bits |= CM_ANGLE1;
    if (to.angles[1] !== from.angles[1]) bits |= CM_ANGLE2;
    if (to.angles[2] !== from.angles[2]) bits |= CM_ANGLE3;
    if (to.forwardmove !== from.forwardmove) bits |= CM_FORWARD;
    if (to.sidemove !== from.sidemove) bits |= CM_SIDE;
    if (to.upmove !== from.upmove) bits |= CM_UP;
    if (to.buttons !== from.buttons) bits |= CM_BUTTONS;
    if (to.impulse !== from.impulse) bits |= CM_IMPULSE;

    writer.writeByte(bits);
    writer.writeByte(to.msec);

    if (bits & CM_ANGLE1) writer.writeShort(to.angles[0]);
    if (bits & CM_ANGLE2) writer.writeShort(to.angles[1]);
    if (bits & CM_ANGLE3) writer.writeShort(to.angles[2]);
    if (bits & CM_FORWARD) writer.writeShort(to.forwardmove);
    if (bits & CM_SIDE) writer.writeShort(to.sidemove);
    if (bits & CM_UP) writer.writeShort(to.upmove);
    if (bits & CM_BUTTONS) writer.writeByte(to.buttons);
    if (bits & CM_IMPULSE) writer.writeByte(to.impulse);
  }

  private onPacket(data: Buffer): void {
    this.lastMessageTime = Date.now();

    if (isOOBPacket(data)) {
      this.handleOOB(parseOOBPayload(data));
      return;
    }

    if (!this.netchan || this.state < ConnState.Connected) return;

    const reader = this.netchan.process(data);
    if (!reader) return;

    const callbacks: ParseCallbacks = {
      onServerData: (sd) => this.handleServerData(sd),
      onConfigString: (idx, val) => {
        this.configstrings.set(idx, val);
        this.emit('configstring', idx, val);
      },
      onSpawnBaseline: (ent) => {
        this.emit('baseline', ent);
      },
      onFrame: (frame) => this.handleFrame(frame),
      onPrint: (level, text) => {
        this.emit('print', level, text);
        if (level === PrintLevel.Chat) {
          this.emit('chat', text);
        }
      },
      onStuffText: (text) => {
        this.emit('stufftext', text);
        this.handleStuffText(text);
      },
      onCenterPrint: (text) => this.emit('centerprint', text),
      onDisconnect: () => {
        this.emit('log', 'Server disconnected');
        this.disconnect();
      },
      onReconnect: () => {
        this.emit('log', 'Server requested reconnect');
        this.disconnect();
      },
      onSound: (info) => this.emit('sound', info),
    };

    parseServerMessage(reader, callbacks, this.baselines, this.frames);
  }

  private handleOOB(text: string): void {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'challenge') {
      if (this.state !== ConnState.Challenging) return;
      this.challenge = parseInt(parts[1], 10) || 0;
      this.state = ConnState.Connecting;
      this.connectTime = 0; // fire connect immediately
      this.connectCount = 0;
      this.emit('log', `Got challenge: ${this.challenge}`);
      return;
    }

    if (cmd === 'client_connect') {
      if (this.state !== ConnState.Connecting) return;
      this.emit('log', 'Connection accepted');

      // set up netchan
      this.netchan = new Netchan(
        this.sock!,
        this.host,
        this.port,
        this.qport,
      );

      this.state = ConnState.Connected;

      // send "new" command
      this.sendStringCmd('new');
      this.netchan.transmit();
      return;
    }

    if (cmd === 'print') {
      const msg = text.substring(text.indexOf('\n') + 1);
      this.emit('log', `Server: ${msg.trim()}`);
      this.emit('print', PrintLevel.High, msg);
      return;
    }
  }

  private handleServerData(sd: ServerData): void {
    if (sd.protocol !== PROTOCOL_VERSION_DEFAULT) {
      this.emit('log', `Unsupported protocol ${sd.protocol}, expected ${PROTOCOL_VERSION_DEFAULT}`);
      this.disconnect();
      return;
    }

    this.spawncount = sd.spawncount;
    this.clientnum = sd.clientnum;
    this.gamedir = sd.gamedir;
    this.levelname = sd.levelname;
    this.configstrings.clear();
    this.baselines.clear();
    this.frames = [];
    this.lastFrame = -1;

    this.state = ConnState.Loading;
    this.emit('log', `Server data: map="${sd.levelname}" gamedir="${sd.gamedir}" client=${sd.clientnum}`);
    this.emit('serverdata', sd);
  }

  private handleFrame(frame: ServerFrame): void {
    this.playerstate = frame.playerstate;
    this.lastFrame = frame.number;

    if (this.state === ConnState.Loading || this.state === ConnState.Precached) {
      this.state = ConnState.Active;
      this.emit('log', 'Now active in game');
      this.emit('active');
    }

    this.emit('frame', frame);
  }

  private handleStuffText(text: string): void {
    const cmds = text.trim().split('\n').filter(s => s.length > 0);
    for (const cmd of cmds) {
      console.log(`STUFF>>> ${cmd}`);
      const parts = cmd.trim().split(/\s+/);
      if (parts[0] === 'precache') {
        // server wants us to precache; we respond with begin
        this.state = ConnState.Precached;
        this.emit('log', 'Sending begin...');
        this.sendStringCmd(`begin ${this.spawncount}`);
        if (this.netchan) this.netchan.transmit();
      } else if (parts[0] === 'cmd') {
        // execute as string command to server, expanding known cvars
        let serverCmd = parts.slice(1).join(' ');
        serverCmd = serverCmd.replace('$version', '"ts-aQtion-1.0.0"');
        serverCmd = serverCmd.replace('$actoken', '""');
        console.log(`<<<STUFF ${serverCmd}`);
        this.sendStringCmd(serverCmd);
        if (this.netchan) this.netchan.transmit();
      } else if (parts[0] === 'reconnect') {
        this.emit('log', 'Stufftext reconnect');
        this.sendStringCmd('new');
        if (this.netchan) this.netchan.transmit();
      }
    }
  }
}
