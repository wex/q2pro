import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BspFile } from '../src/bsp';
import { generateMapSvg } from '../src/map-render';
import { buildSynthBsp } from './helpers/fixtures';

describe('generateMapSvg', () => {
    const bsp = BspFile.load(buildSynthBsp());

    test('renders an SVG with the upward-facing quad', () => {
        const svg = generateMapSvg(bsp, 'synthmap', {});
        expect(svg).toContain('<svg');
        expect(svg).toContain('synthmap');
        expect(svg).toContain('<path');       // the quad face
        expect(svg).toContain('test/synth');  // texture name in <title>
        expect(svg).toContain('</svg>');
    });

    test('grid overlay adds axis-aligned lines', () => {
        const svg = generateMapSvg(bsp, 'synthmap', { showGrid: true });
        expect(svg).toContain('<line');
        expect(svg).toContain('rgb(0,255,0)');
    });

    test('markers render for spawn entities', () => {
        const entBsp = BspFile.load(buildSynthBsp(
            '{ "classname" "worldspawn" }\n' +
            '{ "classname" "info_player_deathmatch" "origin" "16 16 0" }',
        ));
        const svg = generateMapSvg(entBsp, 'synthmap', { showMarkers: true });
        expect(svg).toContain('<g id="markers">');
        expect(svg).toContain('fill="#ee3333"');
    });

    test('markers option off hides the marker group', () => {
        const entBsp = BspFile.load(buildSynthBsp(
            '{ "classname" "worldspawn" }\n' +
            '{ "classname" "info_player_deathmatch" "origin" "16 16 0" }',
        ));
        expect(generateMapSvg(entBsp, 'synthmap', {})).not.toContain('<g id="markers">');
    });

    test('skips faces whose normal points down or sideways', () => {
        const buf = Buffer.from(buildSynthBsp());
        // Flip the plane normal to -Z; face becomes invisible top-down.
        // Plane lump is the first data section right after the header.
        const headerSize = 8 + 19 * 8;
        const entityLen = '{ "classname" "worldspawn" }'.length + 1;
        const planeOfs = headerSize + entityLen;
        buf.writeFloatLE(-1, planeOfs + 8); // normal.z = -1
        const b = BspFile.load(buf);
        const svg = generateMapSvg(b, 'synthmap', {});
        expect(svg).not.toContain('<path');
    });

    test('uses WAL texture patterns when textures are provided', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'map-render-'));
        try {
            const texDir = path.join(tmp, 'textures');
            fs.mkdirSync(path.join(texDir, 'test'), { recursive: true });
            const wal = Buffer.alloc(100 + 4);
            wal.write('test/synth', 0, 'ascii');
            wal.writeUInt32LE(2, 32);
            wal.writeUInt32LE(2, 36);
            wal.writeUInt32LE(100, 40);
            wal[100] = 0; wal[101] = 1; wal[102] = 2; wal[103] = 3;
            fs.writeFileSync(path.join(texDir, 'test', 'synth.wal'), wal);
            const pcx = path.join(tmp, 'colormap.pcx');
            fs.writeFileSync(pcx, Buffer.alloc(768, 0x40));

            const svg = generateMapSvg(bsp, 'synthmap', {
                texturesDir: texDir,
                colormapPath: pcx,
            });
            expect(svg).toContain('<pattern id="ti-0"');
            expect(svg).toContain('data:image/png;base64,');
            expect(svg).toContain('url(#ti-0)');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
