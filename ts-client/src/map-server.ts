import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BspFile } from './bsp.js';
import { generateMapSvg } from './map-render.js';

const DEFAULT_PORT = 9999;
const MAP_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAPS_DIR = path.join(__dirname, '..', 'maps');

export class MapServer {
  private readonly port: number;
  private readonly mapsDir: string;

  constructor(port = DEFAULT_PORT, mapsDir = DEFAULT_MAPS_DIR) {
    this.port = port;
    this.mapsDir = mapsDir;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.on('error', reject);
      server.listen(this.port, () => {
        console.log(`[MAP] Server listening on http://localhost:${this.port}/map/<mapname>`);
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = req.url ?? '';
    const match = url.match(/^\/map\/([^/?#]+)/);

    if (!match) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const mapName = match[1];

    if (!MAP_NAME_RE.test(mapName)) {
      res.writeHead(400);
      res.end('Invalid map name');
      return;
    }

    const bspPath = path.join(this.mapsDir, `${mapName}.bsp`);

    if (!fs.existsSync(bspPath)) {
      res.writeHead(404);
      res.end(`Map not found: ${mapName}`);
      return;
    }

    try {
      const bsp = BspFile.loadFile(bspPath);
      const svg = generateMapSvg(bsp, mapName);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
      });
      res.end(svg);
    } catch (err) {
      console.error(`[MAP] Error rendering ${mapName}:`, err);
      res.writeHead(500);
      res.end('Error generating map SVG');
    }
  }
}
