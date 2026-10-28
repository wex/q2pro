import { StatsTracker, DEFAULT_ROUND_PATTERNS } from '../src/stats';

const NAMES: Record<number, string> = { 0: 'Alice', 1: 'Bob', 2: 'Carol' };
const namer = (n: number) => NAMES[n];

function tracker(opts: { now?: () => number } = {}) {
    return new StatsTracker({ namer, ...opts });
}

describe('StatsTracker aggregation', () => {
    test('obituary with attacker increments kills and weapon tally', () => {
        const s = tracker();
        s.noteObituary({ victim: 'Bob', attacker: 'Alice', weapon: 'sniper' });
        s.noteObituary({ victim: 'Carol', attacker: 'Alice', weapon: 'sniper' });
        s.noteObituary({ victim: 'Alice', attacker: 'Bob', weapon: 'mk23' });
        const snap = s.snapshot();
        expect(snap.rounds).toHaveLength(1);
        const players = snap.rounds[0].players;
        expect(players['Alice'].kills).toBe(2);
        expect(players['Alice'].weaponsUsed).toEqual({ sniper: 2 });
        expect(players['Bob'].kills).toBe(1);
        expect(snap.rounds[0].weaponKills).toEqual({ sniper: 2, mk23: 1 });
        expect(snap.totals.players['Alice'].kills).toBe(2);
        expect(snap.totals.weaponKills).toEqual({ sniper: 2, mk23: 1 });
    });

    test('suicide/world obituaries award no kills and no deaths', () => {
        const s = tracker();
        s.noteObituary({ victim: 'Bob', attacker: null, weapon: 'suicide' });
        const p = s.snapshot().rounds[0].players;
        expect(p['Bob']).toBeUndefined();
        expect(p['']).toBeUndefined();
    });

    test('deaths come from noteDeath only — obituary never double-counts', () => {
        const s = tracker();
        // Obituary arrives for a kill; the victim's own death edge also fires.
        s.noteObituary({ victim: 'Bob', attacker: 'Alice', weapon: 'mk23' });
        s.noteDeath({ clientNum: 1 });
        const p = s.snapshot().rounds[0].players;
        expect(p['Bob'].deaths).toBe(1);
        expect(p['Alice'].kills).toBe(1);
    });

    test('hits aggregate per-location; hitsTaken tracked separately', () => {
        const s = tracker();
        s.noteHit({ attacker: 0, victim: 'Bob', location: 'head' });
        s.noteHit({ attacker: 0, victim: 'Bob', location: 'head' });
        s.noteHit({ attacker: 0, victim: 'Carol', location: '' });
        s.noteHitTaken({ victim: 1, attacker: 'Alice' });
        const p = s.snapshot().rounds[0].players;
        expect(p['Alice'].hits).toBe(3);
        expect(p['Alice'].hitsByLocation).toEqual({ head: 2, body: 1 });
        expect(p['Bob'].hitsTaken).toBe(1);
    });

    test('unknown clientNum falls back to the numeric string', () => {
        const s = new StatsTracker(); // no namer
        s.noteDeath({ clientNum: 7 });
        s.noteHit({ attacker: 7, victim: 'x', location: 'legs' });
        const p = s.snapshot().rounds[0].players;
        expect(p['7'].deaths).toBe(1);
        expect(p['7'].hits).toBe(1);
        expect(p['7'].hitsByLocation).toEqual({ legs: 1 });
    });
});

describe('StatsTracker round boundaries', () => {
    test('matching text opens a new round and freezes the old one', () => {
        let t = 1000;
        const s = new StatsTracker({ namer, now: () => t });
        s.noteObituary({ victim: 'Bob', attacker: 'Alice', weapon: 'sniper' });
        t = 2000;
        expect(s.noteText('FIGHT!')).toBe(true);
        s.noteObituary({ victim: 'Alice', attacker: 'Bob', weapon: 'mk23' });
        const snap = s.snapshot();
        expect(snap.rounds).toHaveLength(2);
        expect(snap.rounds[0].startedAt).toBe(1000);
        expect(snap.rounds[0].players['Alice'].kills).toBe(1);
        expect(snap.rounds[1].startedAt).toBe(2000);
        expect(snap.rounds[1].players['Bob'].kills).toBe(1);
        // Totals span both rounds.
        expect(snap.totals.players['Alice'].kills).toBe(1);
        expect(snap.totals.players['Bob'].kills).toBe(1);
    });

    test('non-matching text keeps the current round', () => {
        const s = tracker();
        expect(s.noteText('grats team')).toBe(false);
        expect(s.noteText('')).toBe(false);
        expect(s.snapshot().rounds).toHaveLength(1);
    });

    test('default patterns cover the AQ2 boundary strings', () => {
        const s = tracker();
        for (const text of ['FIGHT!', 'Round 4', 'match start', 'timelimit hit']) {
            expect(s.noteText(text)).toBe(true);
        }
        expect(s.snapshot().rounds).toHaveLength(5);
    });

    test('custom roundPatterns replace the defaults', () => {
        const s = new StatsTracker({ namer, roundPatterns: [/^GO$/] });
        expect(s.noteText('FIGHT!')).toBe(false);
        expect(s.noteText('GO')).toBe(true);
    });

    test('maxRounds caps retained rounds', () => {
        const s = new StatsTracker({ namer, maxRounds: 3 });
        for (let i = 0; i < 6; i++) s.noteText('FIGHT!');
        const snap = s.snapshot();
        expect(snap.rounds).toHaveLength(3);
        expect(snap.rounds[0].index).toBe(4); // oldest dropped
    });

    test('reset() clears everything', () => {
        const s = tracker();
        s.noteObituary({ victim: 'Bob', attacker: 'Alice', weapon: 'sniper' });
        s.reset();
        const snap = s.snapshot();
        expect(snap.rounds).toHaveLength(1);
        expect(snap.rounds[0].players).toEqual({});
        expect(snap.totals.players).toEqual({});
    });
});

describe('StatsTracker snapshot shape', () => {
    test('snapshot is JSON-safe and defensive-copied', () => {
        const s = tracker();
        s.noteHit({ attacker: 0, victim: 'Bob', location: 'head' });
        const snap = s.snapshot();
        expect(() => JSON.stringify(snap)).not.toThrow();
        // Mutating the snapshot must not leak back into the tracker.
        snap.rounds[0].players['Alice'].hitsByLocation['head'] = 999;
        expect(s.snapshot().rounds[0].players['Alice'].hitsByLocation['head']).toBe(1);
    });
});
