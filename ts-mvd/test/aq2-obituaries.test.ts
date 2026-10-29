import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyObituary } from '../src/frame';
import { classifyAq2Obituary, expandedTemplates } from '../src/aq2-obituaries';

describe('classifyAq2Obituary — kill templates', () => {
    test('MK23 headshot', () => {
        expect(classifyAq2Obituary("fren waters has a hole in his head from mJw - Royce's Mark 23 pistol"))
            .toEqual({ kind: 'kill', victim: 'fren waters', attacker: 'mJw - Royce', mod: 'mk23', location: 'head' });
    });

    test('shared " was shot by" body is disambiguated by message2', () => {
        expect(classifyAq2Obituary("Vic was shot by Att's M4 Assault Rifle")!.mod).toBe('m4');
        expect(classifyAq2Obituary("Vic was shot by Att's MP5/10 Submachinegun")!.mod).toBe('mp5');
        expect(classifyAq2Obituary("Vic was shot by Att's Mark 23 Pistol")!.mod).toBe('mk23');
        expect(classifyAq2Obituary("Vic was shot by Att's pair of Mark 23 Pistols")!.mod).toBe('dual');
    });

    test('sniper vs dual " was shot in the legs by" splits on suffix', () => {
        expect(classifyAq2Obituary('Vic was shot in the legs by Att')!.mod).toBe('sniper');
        expect(classifyAq2Obituary("Vic was shot in the legs by Att's akimbo Mark 23 pistols")!.mod).toBe('dual');
    });

    test('" caught" variants split on message2', () => {
        expect(classifyAq2Obituary("Vic caught Att's handgrenade")!.mod).toBe('handgrenade');
        expect(classifyAq2Obituary("Vic caught Att's iron fist")!.mod).toBe('punch');
        expect(classifyAq2Obituary("Vic caught Att's flying knife with her forehead")!.mod)
            .toBe('knife_thrown');
    });

    test('message without leading space ("was blasted by") still splits victim', () => {
        // C emits "%s%s %s%s" → "Vicwas blasted by Att" (no separator).
        const o = classifyAq2Obituary('Vicwas blasted by Att');
        expect(o).toMatchObject({ kind: 'kill', victim: 'Vic', attacker: 'Att', mod: 'blaster' });
    });

    test('attacker names containing " by ", " from ", "\'s " parse correctly', () => {
        const o = classifyAq2Obituary("Vic was shot by Att by the lake's M4 Assault Rifle");
        expect(o).toMatchObject({ attacker: 'Att by the lake', mod: 'm4' });
        const o2 = classifyAq2Obituary("Vic has a hole in his head from Att from LA's Mark 23 pistol");
        expect(o2).toMatchObject({ attacker: 'Att from LA', mod: 'mk23' });
    });

    test('gender variants his/her/its', () => {
        expect(classifyAq2Obituary("Vic had her throat slit by Att")!.mod).toBe('knife');
        expect(classifyAq2Obituary("Vic had its throat slit by Att")!.mod).toBe('knife');
        expect(classifyAq2Obituary("Vic loses its lunch to Att's .45 caliber pistol round")!.mod).toBe('mk23');
        expect(classifyAq2Obituary("Vic got its ass kicked by Att")!.mod).toBe('kick');
    });

    test('kick "Bruce Lee" variant uses object pronoun + trailing message2', () => {
        expect(classifyAq2Obituary('Vic had a Bruce Lee put on him by Att, with a quickness'))
            .toMatchObject({ victim: 'Vic', attacker: 'Att', mod: 'kick' });
    });

    test('special-message push deaths credit the attacker', () => {
        expect(classifyAq2Obituary('Vic was taught how to fly by Att'))
            .toMatchObject({ kind: 'kill', victim: 'Vic', attacker: 'Att', mod: 'falling' });
        expect(classifyAq2Obituary('Vic was thrown through a window by Att'))
            .toMatchObject({ kind: 'kill', mod: 'glass' });
        expect(classifyAq2Obituary('Vic was shoved off the edge by Att'))
            .toMatchObject({ kind: 'kill', mod: 'splash' });
        expect(classifyAq2Obituary('Vic melted thanks to Att'))
            .toMatchObject({ kind: 'kill', mod: 'slime' });
    });
});

describe('classifyAq2Obituary — world / suicide', () => {
    test('world deaths have no attacker', () => {
        expect(classifyAq2Obituary('mJw - Royce plummets to his death'))
            .toEqual({ kind: 'world', victim: 'mJw - Royce', attacker: null, mod: 'falling', location: null });
        expect(classifyAq2Obituary('Vic ate too much glass')!.mod).toBe('glass');
        expect(classifyAq2Obituary('Vic was in the wrong place')!.mod).toBe('splash');
        expect(classifyAq2Obituary('Vic does a back flip into the lava')!.mod).toBe('lava');
        expect(classifyAq2Obituary('Vic sank like a rock')!.mod).toBe('water');
    });

    test('suicides', () => {
        expect(classifyAq2Obituary('Vic killed herself'))
            .toMatchObject({ kind: 'suicide', mod: 'suicide', attacker: null });
        expect(classifyAq2Obituary('Vic is done with the world')!.kind).toBe('suicide');
        expect(classifyAq2Obituary("Vic didn't throw his grenade far enough")!.mod).toBe('hg_splash');
        expect(classifyAq2Obituary('Vic tripped on her own grenade')!.mod).toBe('g_splash');
        expect(classifyAq2Obituary('Vic tried to put the pin back in')!.mod).toBe('held_grenade');
    });

    test('vanilla "died" fallback', () => {
        expect(classifyAq2Obituary('Vic died')).toMatchObject({ kind: 'world', mod: 'unknown' });
    });

    test('non-obituary lines return null', () => {
        expect(classifyAq2Obituary('Saving node table...')).toBeNull();
        expect(classifyAq2Obituary('done (335 updated)')).toBeNull();
        expect(classifyAq2Obituary('X is now known as Y.')).toBeNull();
        expect(classifyAq2Obituary('')).toBeNull();
    });
});

describe('classifyObituary integration', () => {
    test('AQ2 lines produce kill/world/info kinds', () => {
        const kill = classifyObituary("Vic has a hole in his head from Att's Mark 23 pistol\n");
        expect(kill).toMatchObject({
            kind: 'kill', victim: 'Vic', attacker: 'Att', weapon: 'mk23', mod: 'mk23', location: 'head',
        });
        const info = classifyObituary('Saving node table...\n');
        expect(info).toMatchObject({ kind: 'info', victim: '', attacker: null, weapon: null });
        const world = classifyObituary('Vic plummets to her death\n');
        expect(world).toMatchObject({ kind: 'world', attacker: null, mod: 'falling' });
    });

    test('vanilla fallbacks still work for non-AQ2 mods', () => {
        expect(classifyObituary('Vic was railed by Att\n'))
            .toMatchObject({ kind: 'kill', victim: 'Vic', attacker: 'Att', mod: null });
        expect(classifyObituary('Vic cratered\n'))
            .toMatchObject({ kind: 'world', victim: 'Vic' });
    });
});

describe('parity with src/action/p_client.c', () => {
    // Slice ClientObituary() out of the C source and require that every
    // message / message2 / special_message string literal it can emit is
    // covered by our template table. Catches silent drift when the mod's
    // table changes.
    const cPath = path.resolve(__dirname, '..', '..', 'src', 'action', 'p_client.c');
    const cSrc = fs.readFileSync(cPath, 'latin1');
    const start = cSrc.indexOf('void ClientObituary(');
    const end = cSrc.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Strip `//` comments — the C source keeps dead template lines around
    // (e.g. `//message = "hit the ground hard, real hard";`). No literal in
    // this function contains `//`.
    const body = cSrc.slice(start, end).replace(/\/\/[^\n]*/g, '');

    const lit = (re: RegExp): string[] =>
        [...body.matchAll(re)].map((m) => m[1]).filter((s) => s.length > 0);

    const messages = new Set(lit(/\bmessage\s*=\s*"([^"]*)"/g));
    const message2s = new Set(lit(/\bmessage2\s*=\s*"([^"]*)"/g));
    const specials = new Set(lit(/\bspecial_message\s*=\s*"([^"]*)"/g));

    const templates = expandedTemplates();
    const coveredMessages = new Set(templates.map((t) => t.m));
    const coveredMessage2 = new Set(templates.map((t) => t.m2).filter(Boolean));
    const coveredSpecials = new Set(
        templates.filter((t) => t.fmt === 'special').map((t) => t.m),
    );

    test('every C `message` literal is covered', () => {
        const missing = [...messages].filter((s) => !coveredMessages.has(s));
        expect(missing).toEqual([]);
    });

    test('every C `message2` literal is covered', () => {
        const missing = [...message2s].filter((s) => !coveredMessage2.has(s));
        expect(missing).toEqual([]);
    });

    test('every C `special_message` literal is covered', () => {
        const missing = [...specials].filter((s) => !coveredSpecials.has(s));
        expect(missing).toEqual([]);
    });

    test('every expanded template classifies end-to-end', () => {
        for (const t of templates) {
            // Reproduce the C sprintf shapes: `v+m+' '+a+m2`,
            // `v+' '+m+' '+a` (special), `v+' '+m` (world).
            const line = t.fmt === 'kill'
                ? `Vic${t.m} Att${t.m2}`
                : t.fmt === 'special'
                    ? `Vic ${t.m} Att`
                    : `Vic ${t.m}`;
            const o = classifyAq2Obituary(line);
            expect(o).not.toBeNull();
            expect(o!.mod).toBe(t.mod);
        }
    });
});
