import * as net from 'net';
import { EventEmitter } from 'events';
import { BufferReader, BufferWriter } from './buffer';
import {
    MVD_MAGIC,
    GTV_PROTOCOL_VERSION,
    MAX_GTS_MSGLEN,
    GTF_STRINGCMDS,
    GtvServerOp,
    GtvClientOp,
    ClientState,
} from './protocol';

// ── Event map ───────────────────────────────────────────────────────

export interface MvdClientEventMap {
    connect: [];
    hello: [flags: number];
    streamStart: [];
    streamStop: [];
    streamData: [data: Buffer];
    streamSuspend: [];
    streamResume: [data: Buffer];
    pong: [];
    error: [info: { code: string; message: string }];
    disconnect: [info: { reason: string }];
    close: [];
    stateChange: [info: { from: ClientState; to: ClientState }];
}

// ── Options ─────────────────────────────────────────────────────────

export interface MvdClientOptions {
    host: string;
    port: number;
    username?: string;
    password?: string;
    version?: string;
    /** Request string command forwarding (default: true) */
    stringCmds?: boolean;
    /** Max frames to buffer on server side (default: 25) */
    maxBuf?: number;
    /** Ping interval in ms (default: 60000) */
    pingInterval?: number;
    /** Auto-reconnect on drop (default: false) */
    autoReconnect?: boolean;
    /** Initial reconnect delay in ms (default: 5000) */
    reconnectDelay?: number;
    /** Max reconnect delay in ms (default: 300000) */
    reconnectMaxDelay?: number;
}

// ── Typed emitter interface via declaration merging ──────────────────

export declare interface MvdClient {
    on<K extends keyof MvdClientEventMap>(event: K, listener: (...args: MvdClientEventMap[K]) => void): this;
    once<K extends keyof MvdClientEventMap>(event: K, listener: (...args: MvdClientEventMap[K]) => void): this;
    emit<K extends keyof MvdClientEventMap>(event: K, ...args: MvdClientEventMap[K]): boolean;
    off<K extends keyof MvdClientEventMap>(event: K, listener: (...args: MvdClientEventMap[K]) => void): this;
}

// ── Main client class ───────────────────────────────────────────────

export class MvdClient extends EventEmitter {
    private socket: net.Socket | null = null;
    private _state: ClientState = ClientState.Disconnected;
    private recvBuf: Buffer = Buffer.alloc(0);
    private pendingMsgLen = 0;
    private negotiatedFlags = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private suspended = false;
    private destroyed = false;

    private readonly opts: Required<MvdClientOptions>;

    constructor(options: MvdClientOptions) {
        super();
        this.opts = {
            host: options.host,
            port: options.port,
            username: options.username ?? '',
            password: options.password ?? '',
            version: options.version ?? 'ts-mvd/1.0',
            stringCmds: options.stringCmds ?? true,
            maxBuf: options.maxBuf ?? 25,
            pingInterval: options.pingInterval ?? 60_000,
            reconnectDelay: options.reconnectDelay ?? 5_000,
            reconnectMaxDelay: options.reconnectMaxDelay ?? 300_000,
            autoReconnect: options.autoReconnect ?? false,
        };
    }

    get state(): ClientState {
        return this._state;
    }

    get flags(): number {
        return this.negotiatedFlags;
    }

    // ── Public API ──────────────────────────────────────────────────

    connect(): void {
        if (this._state !== ClientState.Disconnected) {
            return;
        }
        this.destroyed = false;
        this.reconnectAttempt = 0;
        this.setState(ClientState.Connecting);

        const sock = new net.Socket();
        this.socket = sock;

        sock.on('connect', () => this.onTcpConnect());
        sock.on('data', (chunk: Buffer) => this.onTcpData(chunk));
        sock.on('error', (err: Error) => this.onTcpError(err));
        sock.on('close', () => this.onTcpClose());

        sock.connect(this.opts.port, this.opts.host);
    }

    disconnect(): void {
        this.destroyed = true;
        this.cleanup();
        this.setState(ClientState.Disconnected);
    }

    /** Send a string command to the game server (requires GTF_STRINGCMDS) */
    sendStringCmd(cmd: string): void {
        if (this._state !== ClientState.Streaming && this._state !== ClientState.Suspended) {
            return;
        }
        if (!(this.negotiatedFlags & GTF_STRINGCMDS)) {
            return;
        }
        const w = new BufferWriter();
        w.writeString(cmd);
        this.sendMessage(GtvClientOp.StringCmd, w.toBuffer());
    }

    /** Send a ping to the server */
    sendPing(): void {
        if (this._state === ClientState.Disconnected || this._state === ClientState.Connecting) {
            return;
        }
        this.sendMessage(GtvClientOp.Ping);
    }

    /** Request to stop the stream */
    sendStreamStop(): void {
        if (this._state !== ClientState.Streaming && this._state !== ClientState.Suspended) {
            return;
        }
        this.sendMessage(GtvClientOp.StreamStop);
    }

    /** Request to (re-)start the stream */
    sendStreamStart(): void {
        const w = new BufferWriter();
        w.writeInt16LE(this.opts.maxBuf);
        this.sendMessage(GtvClientOp.StreamStart, w.toBuffer());
        this.setState(ClientState.Ready);
    }

    // ── TCP event handlers ──────────────────────────────────────────

    private onTcpConnect(): void {
        this.socketWrite(MVD_MAGIC);
        this.setState(ClientState.Connected);
    }

    private onTcpData(chunk: Buffer): void {
        this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
        this.drainRecvBuf();
    }

    private onTcpError(err: Error): void {
        this.emit('error', { code: 'TCP_ERROR', message: err.message });
    }

    private onTcpClose(): void {
        const wasState = this._state;
        this.cleanup();
        this.setState(ClientState.Disconnected);
        this.emit('close');

        if (!this.destroyed && this.opts.autoReconnect && wasState !== ClientState.Disconnected) {
            this.scheduleReconnect();
        }
    }

    // ── Uncompressed receive-buffer processing ──────────────────────

    private drainRecvBuf(): void {
        while (true) {
            // Magic-echo phase
            if (this._state === ClientState.Connected) {
                if (this.recvBuf.length < 4) return;
                const magic = this.recvBuf.subarray(0, 4);
                if (!magic.equals(MVD_MAGIC)) {
                    this.emit('error', { code: 'BAD_MAGIC', message: 'Server did not echo MVD magic' });
                    this.disconnect();
                    return;
                }
                this.recvBuf = this.recvBuf.subarray(4);
                this.emit('connect');
                this.sendHello();
                continue;
            }

            if (!this.parseOneMessage(this.recvBuf, (rest) => { this.recvBuf = rest; })) {
                return;
            }
        }
    }

    // ── Generic framed-message parser ───────────────────────────────

    /**
     * Try to parse one length-prefixed GTV message from `buf`.
     * On success, calls `setBuf` with the remaining bytes and returns true.
     */
    private parseOneMessage(buf: Buffer, setBuf: (rest: Buffer) => void): boolean {
        // Need at least the 2-byte length header
        if (!this.pendingMsgLen) {
            if (buf.length < 2) return false;
            this.pendingMsgLen = buf.readUInt16LE(0);
            buf = buf.subarray(2);
            setBuf(buf);

            if (this.pendingMsgLen === 0) {
                this.emit('disconnect', { reason: 'End of stream' });
                this.disconnect();
                return false;
            }
            if (this.pendingMsgLen > MAX_GTS_MSGLEN) {
                this.emit('error', { code: 'OVERSIZE', message: `Message too large: ${this.pendingMsgLen}` });
                this.disconnect();
                return false;
            }
        }

        if (buf.length < this.pendingMsgLen) return false;

        const msgData = Buffer.from(buf.subarray(0, this.pendingMsgLen));
        setBuf(buf.subarray(this.pendingMsgLen));
        this.pendingMsgLen = 0;

        this.handleMessage(msgData);
        return true;
    }

    // ── Message dispatch ────────────────────────────────────────────

    private handleMessage(data: Buffer): void {
        if (data.length < 1) return;

        const opcode: number = data[0];
        const payload = data.subarray(1);

        switch (opcode) {
            case GtvServerOp.Hello:
                this.handleHello(payload);
                break;
            case GtvServerOp.Pong:
                this.emit('pong');
                break;
            case GtvServerOp.StreamStart:
                this.handleStreamStart();
                break;
            case GtvServerOp.StreamStop:
                this.handleStreamStop();
                break;
            case GtvServerOp.StreamData:
                this.handleStreamData(payload);
                break;
            case GtvServerOp.Error:
                this.emit('error', { code: 'GTS_ERROR', message: 'Server-side error occurred' });
                this.disconnect();
                break;
            case GtvServerOp.BadRequest:
                this.emit('error', { code: 'GTS_BADREQUEST', message: 'Server refused request (bad protocol version)' });
                this.disconnect();
                break;
            case GtvServerOp.NoAccess:
                this.emit('error', { code: 'GTS_NOACCESS', message: 'Access denied (authentication failed)' });
                this.disconnect();
                break;
            case GtvServerOp.Disconnect:
                this.emit('disconnect', { reason: 'Server shut down' });
                this.disconnect();
                break;
            case GtvServerOp.Reconnect:
                this.emit('disconnect', { reason: 'Server restarted' });
                this.cleanup();
                this.setState(ClientState.Disconnected);
                if (this.opts.autoReconnect) {
                    this.scheduleReconnect();
                }
                break;
            default:
                this.emit('error', { code: 'UNKNOWN_OPCODE', message: `Unknown server opcode: ${opcode}` });
                this.disconnect();
                break;
        }
    }

    // ── Opcode handlers ─────────────────────────────────────────────

    private handleHello(payload: Buffer): void {
        if (payload.length < 4) {
            this.emit('error', { code: 'BAD_HELLO', message: 'Server hello too short' });
            this.disconnect();
            return;
        }

        const reader = new BufferReader(payload);
        this.negotiatedFlags = reader.readInt32LE();

        this.emit('hello', this.negotiatedFlags);
        this.setState(ClientState.Preparing);

        // Automatically request stream start
        const w = new BufferWriter();
        w.writeInt16LE(this.opts.maxBuf);
        this.sendMessage(GtvClientOp.StreamStart, w.toBuffer());
        this.setState(ClientState.Ready);

        // Start ping keepalive
        this.startPingTimer();
    }

    private handleStreamStart(): void {
        this.suspended = false;
        this.setState(ClientState.Streaming);
        this.emit('streamStart');
    }

    private handleStreamStop(): void {
        this.emit('streamStop');
        this.setState(ClientState.Preparing);
    }

    private handleStreamData(payload: Buffer): void {
        if (payload.length === 0) {
            // Empty data = stream suspend marker
            if (!this.suspended) {
                this.suspended = true;
                this.setState(ClientState.Suspended);
                this.emit('streamSuspend');
            }
            return;
        }

        if (this.suspended) {
            this.suspended = false;
            this.setState(ClientState.Streaming);
            this.emit('streamResume', payload);
        } else {
            if (this._state === ClientState.Ready) {
                this.setState(ClientState.Streaming);
            }
            this.emit('streamData', payload);
        }
    }

    // ── Send helpers ────────────────────────────────────────────────

    private sendHello(): void {
        let flags = 0;
        if (this.opts.stringCmds) flags |= GTF_STRINGCMDS;

        const w = new BufferWriter();
        w.writeUInt16LE(GTV_PROTOCOL_VERSION);
        w.writeInt32LE(flags);
        w.writeInt32LE(0); // reserved
        w.writeString(this.opts.username);
        w.writeString(this.opts.password);
        w.writeString(this.opts.version);

        this.sendMessage(GtvClientOp.Hello, w.toBuffer());
        this.setState(ClientState.Preparing);
    }

    private sendMessage(opcode: GtvClientOp, payload?: Buffer): void {
        const payloadLen = payload ? payload.length : 0;
        const msgLen = 1 + payloadLen; // opcode byte + payload

        const header = Buffer.allocUnsafe(3);
        header.writeUInt16LE(msgLen, 0);
        header.writeUInt8(opcode, 2);

        this.socketWrite(header);
        if (payload && payloadLen > 0) {
            this.socketWrite(payload);
        }
    }

    private socketWrite(data: Buffer): void {
        if (this.socket && !this.socket.destroyed) {
            this.socket.write(data);
        }
    }

    // ── State management ────────────────────────────────────────────

    private setState(newState: ClientState): void {
        if (this._state === newState) return;
        const from = this._state;
        this._state = newState;
        this.emit('stateChange', { from, to: newState });
    }

    // ── Keepalive ───────────────────────────────────────────────────

    private startPingTimer(): void {
        this.stopPingTimer();
        this.pingTimer = setInterval(() => {
            this.sendPing();
        }, this.opts.pingInterval);
    }

    private stopPingTimer(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    // ── Reconnection ────────────────────────────────────────────────

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        const delay = Math.min(
            this.opts.reconnectDelay * Math.pow(1.5, this.reconnectAttempt),
            this.opts.reconnectMaxDelay,
        );
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    // ── Cleanup ─────────────────────────────────────────────────────

    private cleanup(): void {
        this.stopPingTimer();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }

        this.recvBuf = Buffer.alloc(0);
        this.pendingMsgLen = 0;
        this.suspended = false;
        this.negotiatedFlags = 0;
    }
}
