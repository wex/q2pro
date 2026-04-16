import http from 'node:http';
import type { ServerFrame } from './protocol.js';

export interface ServerContext {
  levelname: string;
  mapname: string;
  gamedir: string;
  clientnum: number;
  players: Array<{ slot: number; entityNum: number; info: string }>;
}

export type SseEventMap = {
  frame: { frame: ServerFrame; context: ServerContext };
  // future event types go here
};

export type SseEventType = keyof SseEventMap;

function sseReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  return value;
}

const DEFAULT_PORT = 8888;

export class SseServer {
  private readonly port: number;
  private readonly clients: Set<http.ServerResponse> = new Set();
  private context: ServerContext = {
    levelname: '',
    mapname: '',
    gamedir: '',
    clientnum: -1,
    players: [],
  };

  constructor(port = DEFAULT_PORT) {
    this.port = port;
  }

  get currentContext(): ServerContext {
    return this.context;
  }

  updateContext(ctx: Partial<ServerContext>): void {
    this.context = { ...this.context, ...ctx };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.url !== '/events') {
          res.writeHead(404);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(':\n\n');

        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
      });

      server.on('error', reject);
      server.listen(this.port, () => {
        console.log(`[SSE] Server listening on http://localhost:${this.port}/events`);
        resolve();
      });
    });
  }

  broadcast<K extends SseEventType>(type: K, data: SseEventMap[K]): void {
    if (this.clients.size === 0) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data, sseReplacer)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }
}
