import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Parity check: every `CS_*` constant in public/consts.js must match the
 * value in src/player-loadout.ts (single source of truth on the wire layout
 * is the TS side — see doc/configstring-layout.md). Catches the duplicated
 * constants drifting apart, which is exactly the bug class that produced
 * AUDIT finding 1.
 */
describe('public/consts.js parity with src/player-loadout.ts', () => {
    const constsPath = path.resolve(__dirname, '..', 'public', 'consts.js');
    const loadoutPath = path.resolve(__dirname, '..', 'src', 'player-loadout.ts');

    function jsConsts(file: string): Record<string, number> {
        const src = fs.readFileSync(file, 'utf8');
        const out: Record<string, number> = {};
        for (const m of src.matchAll(/const\s+(CS_\w+)\s*=\s*(\d+)\s*;/g)) {
            out[m[1]] = Number(m[2]);
        }
        return out;
    }

    function tsConsts(file: string): Record<string, number> {
        const src = fs.readFileSync(file, 'utf8');
        const out: Record<string, number> = {};
        for (const m of src.matchAll(/export\s+const\s+(CS_\w+)\s*=\s*(\d+)\s*;/g)) {
            out[m[1]] = Number(m[2]);
        }
        return out;
    }

    test('consts.js defines at least the layout bases app.js consumes', () => {
        const js = jsConsts(constsPath);
        for (const name of [
            'CS_MODELS_OLD', 'CS_MODELS_EXT',
            'CS_PLAYERSKINS_OLD', 'CS_PLAYERSKINS_EXT',
            'CS_MAXCLIENTS_OLD', 'CS_MAXCLIENTS_EXT',
        ]) {
            expect(js[name]).toBeDefined();
        }
    });

    test('every CS_* value in consts.js equals the TS export', () => {
        const js = jsConsts(constsPath);
        const ts = tsConsts(loadoutPath);
        for (const [name, value] of Object.entries(js)) {
            expect(ts[name]).toBeDefined();
            expect(value).toBe(ts[name]);
        }
    });

    test('no CS_* constant is still redeclared inside app.js', () => {
        const appSrc = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
        expect(appSrc).not.toMatch(/const\s+CS_\w+\s*=/);
    });
});
