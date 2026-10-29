/**
 * Data-driven port of AQ2/TNG `ClientObituary` (`src/action/p_client.c`).
 *
 * The mod composes every death line from three fixed shapes:
 *
 *   kill    "%s%s %s%s"   victim + message + " " + attacker + message2
 *   special "%s %s %s"    victim + " " + special_message + " " + attacker
 *   world   "%s %s"       victim + " " + message           (no attacker)
 *
 * `message`/`message2` come from a fixed table of ~90 literals (some
 * gendered via `pers.gender`), so the wire text is fully enumerable.
 * Templates below use slots instead of enumerating genders:
 *   {g} → his|her|its   {o} → him|her|it   {s} → himself|herself|itself
 *
 * Ambiguity is resolved by matching order: entries are tried longest
 * `message2` first (then longest `message`), so e.g. the shared
 * " was shot by" body text is disambiguated by the weapon suffix and
 * " was shot in the legs by" (sniper, no suffix) only wins when the
 * dual variant's " akimbo Mark 23 pistols" suffix is absent.
 *
 * test/aq2-obituaries.test.ts greps the C source so this table cannot
 * silently drift from what the server actually emits.
 */

export type ObituaryKind = 'kill' | 'world' | 'suicide' | 'info';
export type HitLocationKind = 'head' | 'chest' | 'stomach' | 'legs' | 'body';

export interface Aq2Obituary {
    /** 'kill' credits an attacker; 'world'/'suicide' have none. Never 'info'. */
    kind: Exclude<ObituaryKind, 'info'>;
    victim: string;
    attacker: string | null;
    /** MOD_*-derived token (mk23, knife_thrown, hg_splash, falling, ...). */
    mod: string | null;
    location: HitLocationKind | null;
}

interface KillTemplate {
    /** `message` verbatim (may start with a space or with "'s"). */
    m: string;
    /** `message2` verbatim, '' when none. */
    m2: string;
    mod: string;
    loc?: HitLocationKind;
}

interface TextTemplate {
    /** `message`/`special_message` verbatim (no leading space — the C
     *  format adds it). */
    m: string;
    mod: string;
    /** 'world' = environmental/self death; 'suicide' = attacker==self. */
    kind: 'world' | 'suicide';
}

// ── Kill templates ("%s%s %s%s") ────────────────────────────────────

const KILL_TEMPLATES: readonly KillTemplate[] = [
    // MOD_MK23 (loc-specific; default loc → body)
    { m: ' has a hole in {g} head from', m2: "'s Mark 23 pistol", mod: 'mk23', loc: 'head' },
    { m: ' loses a vital chest organ thanks to', m2: "'s Mark 23 pistol", mod: 'mk23', loc: 'chest' },
    { m: ' loses {g} lunch to', m2: "'s .45 caliber pistol round", mod: 'mk23', loc: 'stomach' },
    { m: ' is legless because of', m2: "'s .45 caliber pistol round", mod: 'mk23', loc: 'legs' },
    { m: ' was shot by', m2: "'s Mark 23 Pistol", mod: 'mk23' },
    // MOD_MP5
    { m: "'s brains are on the wall thanks to", m2: "'s 10mm MP5/10 round", mod: 'mp5', loc: 'head' },
    { m: ' feels some chest pain via', m2: "'s MP5/10 Submachinegun", mod: 'mp5', loc: 'chest' },
    { m: ' needs some Pepto Bismol after', m2: "'s 10mm MP5 round", mod: 'mp5', loc: 'stomach' },
    { m: ' had {g} legs blown off thanks to', m2: "'s MP5/10 Submachinegun", mod: 'mp5', loc: 'legs' },
    { m: ' was shot by', m2: "'s MP5/10 Submachinegun", mod: 'mp5' },
    // MOD_M4
    { m: ' had a makeover by', m2: "'s M4 Assault Rifle", mod: 'm4', loc: 'head' },
    { m: ' feels some heart burn thanks to', m2: "'s M4 Assault Rifle", mod: 'm4', loc: 'chest' },
    { m: ' has an upset stomach thanks to', m2: "'s M4 Assault Rifle", mod: 'm4', loc: 'stomach' },
    { m: ' is now shorter thanks to', m2: "'s M4 Assault Rifle", mod: 'm4', loc: 'legs' },
    { m: ' was shot by', m2: "'s M4 Assault Rifle", mod: 'm4' },
    // MOD_M3 (2 random variants)
    { m: ' accepts', m2: "'s M3 Super 90 Assault Shotgun in hole-y matrimony", mod: 'm3' },
    { m: ' is full of buckshot from', m2: "'s M3 Super 90 Assault Shotgun", mod: 'm3' },
    // MOD_HC (5 variants incl. single-barrel Deathwatch texts)
    { m: ' underestimated', m2: "'s single barreled handcannon shot", mod: 'hc' },
    { m: ' ate', m2: "'s sawed-off 12 gauge", mod: 'hc' },
    { m: " won't be able to pass a metal detector anymore thanks to", m2: "'s single barreled handcannon shot", mod: 'hc' },
    { m: ' is full of buckshot from', m2: "'s sawed off shotgun", mod: 'hc' },
    { m: ' was minched by', m2: '', mod: 'hc' },
    // MOD_SNIPER (no message2 — attacker ends the line)
    { m: ' saw the sniper bullet go through {g} scope thanks to', m2: '', mod: 'sniper', loc: 'head' },
    { m: ' caught a sniper bullet between the eyes from', m2: '', mod: 'sniper', loc: 'head' },
    { m: ' was picked off by', m2: '', mod: 'sniper', loc: 'chest' },
    { m: ' was sniped in the stomach by', m2: '', mod: 'sniper', loc: 'stomach' },
    { m: ' was shot in the legs by', m2: '', mod: 'sniper', loc: 'legs' },
    { m: ' was sniped by', m2: '', mod: 'sniper' },
    // MOD_DUAL
    { m: ' was trepanned by', m2: "'s akimbo Mark 23 pistols", mod: 'dual', loc: 'head' },
    { m: " was John Woo'd by", m2: '', mod: 'dual', loc: 'chest' },
    { m: ' needs some new kidneys thanks to', m2: "'s akimbo Mark 23 pistols", mod: 'dual', loc: 'stomach' },
    { m: ' was shot in the legs by', m2: "'s akimbo Mark 23 pistols", mod: 'dual', loc: 'legs' },
    { m: ' was shot by', m2: "'s pair of Mark 23 Pistols", mod: 'dual' },
    // MOD_KNIFE
    { m: ' had {g} throat slit by', m2: '', mod: 'knife', loc: 'head' },
    { m: ' had open heart surgery, compliments of', m2: '', mod: 'knife', loc: 'chest' },
    { m: ' was gutted by', m2: '', mod: 'knife', loc: 'stomach' },
    { m: ' was stabbed repeatedly in the legs by', m2: '', mod: 'knife', loc: 'legs' },
    { m: ' was slashed apart by', m2: "'s Combat Knife", mod: 'knife' },
    // MOD_KNIFE_THROWN
    { m: ' caught', m2: "'s flying knife with {g} forehead", mod: 'knife_thrown', loc: 'head' },
    { m: "'s ribs don't help against", m2: "'s flying knife", mod: 'knife_thrown', loc: 'chest' },
    { m: ' sees the contents of {g} own stomach thanks to', m2: "'s flying knife", mod: 'knife_thrown', loc: 'stomach' },
    { m: ' had {g} legs cut off thanks to', m2: "'s flying knife", mod: 'knife_thrown', loc: 'legs' },
    { m: ' was hit by', m2: "'s flying Combat Knife", mod: 'knife_thrown' },
    // MOD_KICK (3 random variants)
    { m: ' got {g} ass kicked by', m2: '', mod: 'kick' },
    { m: " couldn't remove", m2: "'s boot from {g} ass", mod: 'kick' },
    { m: ' had a Bruce Lee put on {o} by', m2: ', with a quickness', mod: 'kick' },
    // MOD_PUNCH (3 random variants)
    { m: ' got a free facelift by', m2: '', mod: 'punch' },
    { m: ' was knocked out by', m2: '', mod: 'punch' },
    { m: ' caught', m2: "'s iron fist", mod: 'punch' },
    // Vanilla MODs retained by AQ2
    { m: 'was blasted by', m2: '', mod: 'blaster' },
    { m: 'was popped by', m2: "'s grenade", mod: 'grenade' },
    { m: 'was shredded by', m2: "'s shrapnel", mod: 'g_splash' },
    { m: 'was melted by', m2: "'s hyperblaster", mod: 'hyperblaster' },
    { m: ' caught', m2: "'s handgrenade", mod: 'handgrenade' },
    { m: " didn't see", m2: "'s handgrenade", mod: 'hg_splash' },
    { m: ' feels', m2: "'s pain", mod: 'held_grenade' },
    { m: ' tried to invade', m2: "'s personal space", mod: 'telefrag' },
    { m: ' was caught by', m2: "'s grapple", mod: 'grapple' },
    { m: ' was deeply impacted by', m2: "'s grenade", mod: 'grenade_impact' },
];

// ── Special-message templates ("%s %s %s", attacker credited) ────────
// Used when `push_timeout` shows the death was caused by being thrown /
// pushed; AQ2 awards the kill to `self->client->attacker`.

const SPECIAL_TEMPLATES: readonly TextTemplate[] = [
    { m: 'was thrown through a window by', mod: 'glass', kind: 'world' },
    { m: 'was taught how to fly by', mod: 'falling', kind: 'world' },
    { m: 'melted thanks to', mod: 'slime', kind: 'world' },
    { m: 'was drop-kicked into the lava by', mod: 'lava', kind: 'world' },
    { m: 'was shoved off the edge by', mod: 'splash', kind: 'world' },
];

// ── World / suicide templates ("%s %s", no attacker) ────────────────

const WORLD_TEMPLATES: readonly TextTemplate[] = [
    // attacker == self
    { m: 'killed {s}', mod: 'suicide', kind: 'suicide' },
    { m: 'tried to put the pin back in', mod: 'held_grenade', kind: 'suicide' },
    { m: "didn't throw {g} grenade far enough", mod: 'hg_splash', kind: 'suicide' },
    { m: 'tripped on {g} own grenade', mod: 'g_splash', kind: 'suicide' },
    // environmental
    { m: 'ate too much glass', mod: 'glass', kind: 'world' },
    { m: 'is done with the world', mod: 'suicide', kind: 'suicide' },
    { m: 'plummets to {g} death', mod: 'falling', kind: 'world' },
    { m: 'was flattened', mod: 'crush', kind: 'world' },
    { m: 'sank like a rock', mod: 'water', kind: 'world' },
    { m: 'melted', mod: 'slime', kind: 'world' },
    { m: 'does a back flip into the lava', mod: 'lava', kind: 'world' },
    { m: 'blew up', mod: 'explosive', kind: 'world' },
    { m: 'found a way out', mod: 'exit', kind: 'world' },
    { m: 'saw the light', mod: 'laser', kind: 'world' },
    { m: 'got blasted', mod: 'turret', kind: 'world' },
    { m: 'was in the wrong place', mod: 'splash', kind: 'world' },
    // vanilla last-ditch "VICTIM died"
    { m: 'died', mod: 'unknown', kind: 'world' },
];

// ── Matcher compilation ─────────────────────────────────────────────

const SLOT_RE = /\{([gos])\}/g;
const SLOT_ALT: Record<string, string> = {
    g: '(?:his|her|its)',
    o: '(?:him|her|it)',
    s: '(?:himself|herself|itself)',
};

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand {g}/{o}/{s} slots into alternations; escape everything else. */
function tpl(t: string): string {
    let out = '';
    let last = 0;
    for (const m of t.matchAll(SLOT_RE)) {
        out += escapeRegex(t.slice(last, m.index)) + SLOT_ALT[m[1]];
        last = m.index + m[0].length;
    }
    return out + escapeRegex(t.slice(last));
}

interface Compiled {
    re: RegExp;
    mod: string;
    loc: HitLocationKind | null;
    kind: 'kill' | 'world' | 'suicide';
    /** Template source, for the parity test. */
    m: string;
    m2: string;
}

const COMPILED: readonly Compiled[] = (() => {
    const kill = KILL_TEMPLATES.map((t) => ({
        // "%s%s %s%s" → victim + m + ' ' + attacker + m2
        re: new RegExp(`^(.*?)${tpl(t.m)} (.+)${tpl(t.m2)}$`),
        mod: t.mod, loc: t.loc ?? 'body', kind: 'kill' as const, m: t.m, m2: t.m2,
    }));
    // Longest message2 first resolves shared message bodies
    // (" was shot by" ×4, " was shot in the legs by" sniper-vs-dual,
    // " caught" ×3); longest message first as tiebreak.
    kill.sort((a, b) => b.m2.length - a.m2.length || b.m.length - a.m.length);

    const special = SPECIAL_TEMPLATES.map((t) => ({
        // "%s %s %s" → victim + ' ' + m + ' ' + attacker
        re: new RegExp(`^(.*?) ${tpl(t.m)} (.+)$`),
        mod: t.mod, loc: null, kind: 'kill' as const, m: t.m, m2: '',
    }));

    const world = WORLD_TEMPLATES.map((t) => ({
        // "%s %s" → victim + ' ' + m
        re: new RegExp(`^(.*?) ${tpl(t.m)}$`),
        mod: t.mod, loc: null, kind: t.kind, m: t.m, m2: '',
    }));

    return [...kill, ...special, ...world];
})();

/**
 * Match a PRINT_MEDIUM death line against the AQ2 ClientObituary table.
 * Returns null when the line matches no template (caller treats it as
 * a non-obituary 'info' print — e.g. bot nav notices, renames).
 */
export function classifyAq2Obituary(raw: string): Aq2Obituary | null {
    for (const t of COMPILED) {
        const m = raw.match(t.re);
        if (!m) continue;
        return {
            kind: t.kind,
            // Kill templates whose `message` lacks a leading space (the
            // vanilla-retained "was blasted by" group) let a separator
            // space land in the victim capture — trim it so the name
            // still matches playerskin configstrings.
            victim: m[1].trimEnd(),
            attacker: t.kind === 'kill' ? m[2] : null,
            mod: t.mod,
            location: t.loc,
        };
    }
    return null;
}

// ── Parity helpers (used by test/aq2-obituaries.test.ts) ────────────

export interface ExpandedTemplate {
    /** `message` literal with gender slots expanded. */
    m: string;
    /** `message2` literal (kill templates only). */
    m2: string;
    mod: string;
    /** Wire shape: 'kill' = `v+m+' '+a+m2`, 'special' = `v+' '+m+' '+a`, 'world' = `v+' '+m`. */
    fmt: 'kill' | 'special' | 'world';
    kind: 'kill' | 'world' | 'suicide';
}

/**
 * Every template with gender slots expanded to the concrete literals the
 * C source emits. Used by the parity test to (a) prove coverage of every
 * `message`/`message2`/`special_message` literal in ClientObituary and
 * (b) synthesize `victim + m + ' ' + attacker + m2` example lines.
 */
export function expandedTemplates(): ExpandedTemplate[] {
    const genders: Record<string, string[]> = {
        g: ['his', 'her', 'its'],
        o: ['him', 'her', 'it'],
        s: ['himself', 'herself', 'itself'],
    };
    const expand = (s: string): string[] =>
        Object.entries(genders).reduce<string[]>(
            (acc, [k, vs]) => acc.flatMap((x) => vs.map((v) => x.replace(`{${k}}`, v))),
            [s],
        );
    const kill = KILL_TEMPLATES.flatMap((t) =>
        expand(t.m).flatMap((m) =>
            expand(t.m2).map((m2) => ({ m, m2, mod: t.mod, fmt: 'kill' as const, kind: 'kill' as const }))),
    );
    const special = SPECIAL_TEMPLATES.flatMap((t) =>
        expand(t.m).map((m) => ({ m, m2: '', mod: t.mod, fmt: 'special' as const, kind: 'kill' as const })),
    );
    const world = WORLD_TEMPLATES.flatMap((t) =>
        expand(t.m).map((m) => ({ m, m2: '', mod: t.mod, fmt: 'world' as const, kind: t.kind })),
    );
    return [...kill, ...special, ...world];
}
