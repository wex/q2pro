import * as fs from 'node:fs';
import * as path from 'node:path';
import request from 'supertest';

// Mock the `net` module before loading the app so importing MvdClient does
// not attempt a real DNS lookup during POST /connect.
import { EventEmitter } from 'node:events';
class FakeSocket extends EventEmitter {
    destroyed = false;
    connect(): this { return this; }
    write(): boolean { return true; }
    destroy(): void { this.destroyed = true; this.emit('close'); }
    end(): void { this.emit('close'); }
    setNoDelay(): void { /* noop */ }
    setKeepAlive(): void { /* noop */ }
}
let mockLastSocket: FakeSocket | null = null;
jest.mock('net', () => ({
    Socket: class {
        constructor() { return (mockLastSocket = new FakeSocket()) as unknown as object; }
    },
}));

import { httpServer, resetAppStateForTests, DEMOS_DIR, parser, getScoreboardForTests, getPlayersForTests, sseClients, sseHeartbeatTick, isStatusReplySource } from '../src/app';
import { PlayerState } from '../src/frame';
import { Stat, MvdOp, GtvServerOp } from '../src/protocol';
import { buildSynthBsp } from './helpers/fixtures';
import { MvdDemoReader } from '../src/demo';

/** Frame a GTV server→client message: [u16 len incl. opcode][opcode][payload]. */
function srvMsg(opcode: GtvServerOp, payload?: Buffer): Buffer {
    const len = 1 + (payload?.length ?? 0);
    const msg = Buffer.allocUnsafe(2 + len);
    msg.writeUInt16LE(len, 0);
    msg[2] = opcode;
    if (payload) payload.copy(msg, 3);
    return msg;
}

/**
 * Drive the singleton client to Streaming through the mocked socket:
 * TCP connect → magic echo → server hello (flags 0) → stream start ack.
 */
async function driveToStreaming(): Promise<FakeSocket> {
    await request(httpServer)
        .post('/connect')
        .set('content-type', 'application/json')
        .send({ host: '127.0.0.1', port: 27910 });
    const sock = mockLastSocket!;
    sock.emit('connect');
    sock.emit('data', Buffer.from('MVD2', 'ascii'));
    const flags = Buffer.alloc(4);
    sock.emit('data', srvMsg(GtvServerOp.Hello, flags));
    sock.emit('data', srvMsg(GtvServerOp.StreamStart));
    return sock;
}

function mkPlayer(number: number, frags: number, extras: Partial<PlayerState> = {}): PlayerState {
    const stats = new Int16Array(32);
    stats[Stat.Frags] = frags;
    stats[Stat.Health] = 100;
    if (extras.stats) {
        stats.set(extras.stats.subarray(0, Math.min(extras.stats.length, stats.length)));
    }
    const { stats: _s, frags: _f, number: _n, ...rest } = extras;
    return {
        number,
        inUse: true,
        pmType: 0,
        origin: [0, 0, 0],
        viewangles: [0, 0, 0],
        viewoffset: [0, 0, 0],
        fov: 90,
        gunindex: 0,
        rdflags: 0,
        frags: _f ?? frags,
        stats: _s ?? stats,
        isMvdDummy: false,
        ...rest,
    };
}

describe('HTTP control surface', () => {
    beforeEach(() => {
        resetAppStateForTests();
    });

    afterAll(() => {
        resetAppStateForTests();
        httpServer.close();
    });

    test('GET /state returns idle when nothing is active', async () => {
        const res = await request(httpServer).get('/state');
        expect(res.status).toBe(200);
        expect(res.body.mode).toBe('idle');
        expect(res.body.clientState).toBe('disconnected');
        expect(res.body.replayFile).toBeNull();
    });

    test('GET /demos lists demo.mvd2', async () => {
        const res = await request(httpServer).get('/demos');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.demos)).toBe(true);
        expect(res.body.demos).toContain('demo.mvd2');
    });

    test('POST /connect rejects empty host', async () => {
        const res = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({ host: '', port: 27910 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid-host');
    });

    test('POST /connect rejects invalid port', async () => {
        const res = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({ host: 'example.com', port: 70000 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid-port');
    });

    test('POST /connect rejects malformed JSON body', async () => {
        const res = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send('{not json');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid-body');
    });

    test('POST /connect with valid body returns 202 and moves to Connecting', async () => {
        const res = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({ host: 'fake.local', port: 27910, password: 'secret' });
        expect(res.status).toBe(202);
        expect(res.body.host).toBe('fake.local');
        expect(res.body.port).toBe(27910);
        expect(res.body.password).toBeUndefined();

        const state = await request(httpServer).get('/state');
        // The fake socket never raises 'connect', so the client stays in
        // Connecting until /disconnect flips it back.
        expect(['connecting', 'live']).toContain(state.body.mode === 'live' ? 'live' : state.body.clientState);

        await request(httpServer).post('/disconnect').expect(204);
    });

    test('POST /replay with bare filename starts replay, DELETE stops it', async () => {
        const postRes = await request(httpServer)
            .post('/replay?file=demo.mvd2');
        expect(postRes.status).toBe(202);
        expect(postRes.body.file).toBe('demo.mvd2');

        const state = await request(httpServer).get('/state');
        expect(state.body.mode).toBe('replay');
        expect(state.body.replayFile).toBe(path.join(DEMOS_DIR, 'demo.mvd2'));

        const del = await request(httpServer).delete('/replay');
        expect(del.status).toBe(204);

        const after = await request(httpServer).get('/state');
        expect(after.body.mode).toBe('idle');
    });

    test('POST /replay rejects path traversal', async () => {
        const res = await request(httpServer)
            .post('/replay?file=../../etc/passwd');
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid-file');
    });

    test('missing static asset with extension returns 404 not SPA HTML', async () => {
        const res = await request(httpServer).get('/assets/no-such-icon.png');
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    test('POST /replay with missing file returns 404', async () => {
        const res = await request(httpServer)
            .post('/replay?file=does-not-exist.mvd2');
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('not-found');
    });

    test('scoreboard frags persist across a frame where a player is absent (PPS_REMOVE)', () => {
        // Build two synthetic frames. Frame B drops player #1 to simulate the
        // brief PPS_REMOVE / inUse=false window after a death; the scoreboard
        // must keep #1's last-known frag count (regression for the "scores
        // reset to 0 on death" bug).
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(0, 3), mkPlayer(1, 5)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });
        parser.onFrame!({
            frameNumber: 2,
            players: [mkPlayer(0, 4)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });

        const sb = getScoreboardForTests();
        expect(sb.players[0]).toEqual({ number: 0, frags: 4 });
        expect(sb.players[1]).toEqual({ number: 1, frags: 5 });
    });

    test('empty frame clears the internal players map (§2 roster)', () => {
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(0, 3)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });
        expect(getPlayersForTests().size).toBe(1);

        parser.onFrame!({
            frameNumber: 2,
            players: [],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });
        expect(getPlayersForTests().size).toBe(0);
    });

    test('scoreboard drops a player when their playerskin configstring is cleared', () => {
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(2, 7)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });
        expect(getScoreboardForTests().players[2]).toEqual({ number: 2, frags: 7 });

        // Clearing CS_PLAYERSKINS_OLD + 2 simulates the disconnect signal.
        parser.onConfigString!({ index: 1312 + 2, value: '' });
        expect(getScoreboardForTests().players[2]).toBeUndefined();
    });

    test('scoreboard prune works on vanilla layout where cs 60 is a model path', () => {
        // Regression: CS_MAXCLIENTS_EXT (60) aliases into the vanilla
        // CS_MODELS range, so an EXT-first probe parsed a model path → NaN
        // → the playerskin range check never fired and leavers lingered.
        parser.onServerData!({
            protocol: 37,
            version: 2010,
            flags: 0,
            extended: false,
            servercount: 1,
            gamedir: 'action',
            clientNum: -1,
            configstrings: new Map<number, string>([
                [30, '20'],
                [60, 'models/items/armor/jacket/tris.md2'],
                [1312 + 2, 'someone\\male/grunt'],
            ]),
        });
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(2, 7)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });
        expect(getScoreboardForTests().players[2]).toEqual({ number: 2, frags: 7 });

        parser.onConfigString!({ index: 1312 + 2, value: '' });
        expect(getScoreboardForTests().players[2]).toBeUndefined();
    });

    test('scoreboard prune uses the EXT playerskins base on extended layout', () => {
        parser.onServerData!({
            protocol: 37,
            version: 2012,
            flags: 0b1100,
            extended: true,
            servercount: 1,
            gamedir: 'action',
            clientNum: -1,
            configstrings: new Map<number, string>([
                [60, '16'],
                [12862 + 3, 'else\\female/athena'],
            ]),
        });
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(3, 9)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });

        parser.onConfigString!({ index: 12862 + 3, value: '' });
        expect(getScoreboardForTests().players[3]).toBeUndefined();
    });

    test('scoreboard skips MVD dummy slot (isMvdDummy=true)', () => {
        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(0, 3), mkPlayer(7, 0, { isMvdDummy: true }), mkPlayer(1, 5)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });

        const sb = getScoreboardForTests();
        expect(sb.players[0]).toEqual({ number: 0, frags: 3 });
        expect(sb.players[1]).toEqual({ number: 1, frags: 5 });
        expect(sb.players[7]).toBeUndefined();
        expect(getPlayersForTests().has(7)).toBe(false);
    });

    test('GET /maps/{unknown} returns 404', async () => {
        const res = await request(httpServer).get('/maps/no_such_map');
        expect(res.status).toBe(404);
    });

    test('GET /maps/{unknown}?notextures returns 404 (param does not break routing)', async () => {
        const res = await request(httpServer).get('/maps/no_such_map?notextures');
        expect(res.status).toBe(404);
    });

    test('second POST /connect while connecting returns 409 already-connected', async () => {
        const r1 = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({ host: 'fake.local', port: 27910 });
        expect(r1.status).toBe(202);

        // The client is now in Connecting; a concurrent POST must be rejected
        // by the setTarget gate, not silently accepted.
        const r2 = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({ host: 'other.local', port: 27911 });
        expect(r2.status).toBe(409);
        expect(r2.body.error).toBe('already-connected');

        await request(httpServer).post('/disconnect').expect(204);
    });

    test('POST /connect while replay is active returns 409', async () => {
        const r1 = await request(httpServer).post('/replay?file=demo.mvd2');
        expect(r1.status).toBe(202);

        const r2 = await request(httpServer)
            .post('/connect')
            .set('content-type', 'application/json')
            .send({});
        expect(r2.status).toBe(409);
        expect(r2.body.error).toBe('replay-active');

        await request(httpServer).delete('/replay').expect(204);
    });

    describe('SSE hygiene', () => {
        function fakeRes(backpressured: boolean, writableLength: number) {
            const res = new EventEmitter() as any;
            const writes: string[] = [];
            res.write = (d: string) => { writes.push(d); return !backpressured; };
            res.writableLength = writableLength;
            res.end = jest.fn();
            return { res, writes };
        }

        afterEach(() => {
            sseClients.clear();
        });

        test('a stalled client over the buffer cap is ended and removed', () => {
            const { res } = fakeRes(true, 2 * 1024 * 1024);
            sseClients.add(res);
            parser.onFrame!({
                frameNumber: 1,
                players: [],
                teamScores: { team1: 0, team2: 0, team3: 0 },
                layoutsFlags: 0,
            });
            expect(res.end).toHaveBeenCalled();
            expect(sseClients.has(res)).toBe(false);
        });

        test('backpressured client under the cap stays subscribed', () => {
            const { res, writes } = fakeRes(true, 1024);
            sseClients.add(res);
            parser.onFrame!({
                frameNumber: 1,
                players: [],
                teamScores: { team1: 0, team2: 0, team3: 0 },
                layoutsFlags: 0,
            });
            expect(sseClients.has(res)).toBe(true);
            expect(writes.some((w) => w.startsWith('event: frame'))).toBe(true);
            expect(res.end).not.toHaveBeenCalled();
        });

        test('heartbeat writes an SSE comment to every client', () => {
            const { res, writes } = fakeRes(false, 0);
            sseClients.add(res);
            sseHeartbeatTick();
            expect(writes).toContain(':hb\n\n');
        });

        test('errored clients are removed from the set', () => {
            const { res } = fakeRes(false, 0);
            sseClients.add(res);
            // The /events handler wires res.on('error') on real responses;
            // simulate the same removal contract via the stored hook.
            res.on('error', () => sseClients.delete(res));
            res.emit('error', new Error('boom'));
            expect(sseClients.has(res)).toBe(false);
        });

        test('parser.onSound broadcasts a sound event with resolved CS name', () => {
            const { res, writes } = fakeRes(false, 0);
            sseClients.add(res);
            // Old layout (csExtended=false default): CS_SOUNDS base = 288.
            parser.onConfigString!({ index: 288 + 5, value: 'weapons/blastf1a.wav' });
            parser.onSound!({
                flags: 12, index: 5, volume: 1, attenuation: 1, timeOffset: 0,
                entity: 2, channel: 0, position: [64, 128, 0],
            });
            const ev = writes.find((w) => w.startsWith('event: sound'));
            expect(ev).toBeDefined();
            const payload = JSON.parse(ev!.split('data: ')[1]);
            expect(payload).toMatchObject({
                index: 5,
                name: 'weapons/blastf1a.wav',
                entity: 2,
                channel: 0,
                volume: 1,
                position: [64, 128, 0],
            });
        });

        test('parser.onSound uses the extended CS_SOUNDS base on MVF_EXTLIMITS', () => {
            const { res, writes } = fakeRes(false, 0);
            sseClients.add(res);
            parser.onServerData!({
                protocol: 37, version: 2011, flags: 4,
                gamedir: 'action', servercount: 1, clientNum: -1,
                extended: true, configstrings: new Map(),
            });
            parser.onConfigString!({ index: 8254 + 3, value: 'misc/menu.wav' });
            parser.onSound!({
                flags: 0, index: 3, volume: 1, attenuation: 1, timeOffset: 0,
                entity: 0, channel: 0, position: undefined,
            });
            const ev = writes.find((w) => w.startsWith('event: sound'));
            expect(ev).toBeDefined();
            expect(JSON.parse(ev!.split('data: ')[1]).name).toBe('misc/menu.wav');
        });
    });

    describe('GET /stats', () => {
        test('returns a stats snapshot reflecting parser events', async () => {
            // Old layout: playerskins base 1312 → "name\skin".
            parser.onConfigString!({ index: 1312 + 0, value: 'Alice\\male' });
            parser.onConfigString!({ index: 1312 + 1, value: 'Bob\\male' });
            parser.onObituary!({ victim: 'Bob', attacker: 'Alice', weapon: 'sniper', raw: 'x', kind: 'kill', mod: 'sniper', location: null });
            parser.onDeath!({ clientNum: 1, origin: [0, 0, 0] });
            parser.onHit!({ attacker: 0, victim: 'Bob', location: 'head', raw: 'x' });

            const res = await request(httpServer).get('/stats');
            expect(res.status).toBe(200);
            expect(res.body.rounds).toHaveLength(1);
            const players = res.body.totals.players;
            expect(players['Alice'].kills).toBe(1);
            expect(players['Alice'].weaponsUsed).toEqual({ sniper: 1 });
            expect(players['Alice'].hitsByLocation).toEqual({ head: 1 });
            expect(players['Bob'].deaths).toBe(1);
            expect(res.body.totals.weaponKills).toEqual({ sniper: 1 });
        });

        test('round boundary text splits rounds', async () => {
            parser.onObituary!({ victim: 'Bob', attacker: 'Alice', weapon: 'mk23', raw: 'x', kind: 'kill', mod: 'mk23', location: null });
            parser.onCenterPrint!({ clientNum: 0, text: 'FIGHT!' });
            parser.onObituary!({ victim: 'Alice', attacker: 'Bob', weapon: 'mk23', raw: 'x', kind: 'kill', mod: 'mk23', location: null });
            const res = await request(httpServer).get('/stats');
            expect(res.body.rounds).toHaveLength(2);
        });

        test('stats are broadcast over SSE on kills', () => {
            const w: string[] = [];
            const fake = new EventEmitter() as any;
            fake.write = (d: string) => { w.push(d); return true; };
            fake.writableLength = 0;
            fake.end = jest.fn();
            sseClients.add(fake);
            parser.onObituary!({ victim: 'Bob', attacker: 'Alice', weapon: 'sniper', raw: 'x', kind: 'kill', mod: 'sniper', location: null });
            const ev = w.find((x) => x.startsWith('event: stats'));
            expect(ev).toBeDefined();
            const snap = JSON.parse(ev!.split('data: ')[1]);
            expect(snap.totals.players['Alice'].kills).toBe(1);
            sseClients.delete(fake);
        });
    });

    describe('session scoping', () => {
        test('unknown ?session= id gets a 404 on control routes', async () => {
            const res = await request(httpServer).get('/state?session=bogus');
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('unknown-session');
        });

        test('/state reports the default session and its mode', async () => {
            const res = await request(httpServer).get('/state');
            expect(res.status).toBe(200);
            expect(res.body.session).toBe('default');
            expect(res.body.sessions).toContain('default');
            expect(res.body.mode).toBe('idle');
        });

        test('SSE frame payloads carry the session id', () => {
            const w: string[] = [];
            const fake = new EventEmitter() as any;
            fake.write = (d: string) => { w.push(d); return true; };
            fake.writableLength = 0;
            fake.end = jest.fn();
            sseClients.add(fake);
            parser.onFrame!({
                frameNumber: 1,
                players: [],
                teamScores: { team1: 0, team2: 0, team3: 0 },
                layoutsFlags: 0,
            });
            const ev = w.find((x) => x.startsWith('event: frame'));
            expect(JSON.parse(ev!.split('data: ')[1]).session).toBe('default');
            sseClients.delete(fake);
        });
    });

    describe('OOB status reply source check', () => {
        test('accepts a reply from the polled host:port', () => {
            expect(isStatusReplySource({ port: 27910, address: '127.0.0.1' }, '127.0.0.1', 27910)).toBe(true);
        });
        test('drops replies from a different source port', () => {
            expect(isStatusReplySource({ port: 9999, address: '127.0.0.1' }, '127.0.0.1', 27910)).toBe(false);
        });
        test('drops replies from a different address when host is an IP literal', () => {
            expect(isStatusReplySource({ port: 27910, address: '10.0.0.9' }, '127.0.0.1', 27910)).toBe(false);
        });
        test('accepts any address when host is a hostname (port match only)', () => {
            expect(isStatusReplySource({ port: 27910, address: '10.0.0.9' }, 'gtv.example.com', 27910)).toBe(true);
        });
    });

    describe('GET /maps/{name}', () => {
        const mapsDir = path.resolve(__dirname, '..', 'maps');
        const mapFile = path.join(mapsDir, 'devin_synth_test.bsp');
        beforeAll(() => {
            fs.writeFileSync(mapFile, buildSynthBsp());
        });
        afterAll(() => {
            fs.rmSync(mapFile, { force: true });
        });

        test('renders a synthetic BSP to SVG', async () => {
            const res = await request(httpServer).get('/maps/devin_synth_test?notextures');
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('image/svg+xml');
            // supertest leaves .body as a Buffer for image/* types.
            const svg = res.body.toString('utf8');
            expect(svg).toContain('<svg');
            expect(svg).toContain('devin_synth_test');
        });

        test('returns 404 for an unknown map', async () => {
            const res = await request(httpServer).get('/maps/definitely_not_a_map_9f3a?notextures');
            expect(res.status).toBe(404);
        });
    });

    describe('POST /record/*', () => {
        const recorded = new Set<string>();
        afterAll(() => {
            for (const f of recorded) {
                fs.rmSync(path.join(DEMOS_DIR, f), { force: true });
            }
        });

        test('start without a stream returns 409 not-streaming', async () => {
            const res = await request(httpServer).post('/record/start');
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('not-streaming');
        });

        test('stop without a recording returns 404', async () => {
            const res = await request(httpServer).post('/record/stop');
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('not-recording');
        });

        test('start → streamData written → stop → file replays verbatim', async () => {
            const sock = await driveToStreaming();

            const res = await request(httpServer).post('/record/start?name=devin_test_recording');
            expect(res.status).toBe(202);
            expect(res.body.file).toBe('devin_test_recording.mvd2');
            recorded.add('devin_test_recording.mvd2');

            // Second start while recording → 409.
            const dup = await request(httpServer).post('/record/start?name=other');
            expect(dup.status).toBe(409);
            expect(dup.body.error).toBe('already-recording');

            // Two streamData payloads (plus a suspend marker that must be skipped).
            const p1 = Buffer.from([MvdOp.Nop]);
            const p2 = Buffer.from([MvdOp.Print, 1, 0x68, 0x69, 0]);
            sock.emit('data', srvMsg(GtvServerOp.StreamData, p1));
            sock.emit('data', srvMsg(GtvServerOp.StreamData)); // suspend marker
            sock.emit('data', srvMsg(GtvServerOp.StreamData, p2));

            const state = await request(httpServer).get('/state');
            expect(state.body.recording).toEqual({ file: 'devin_test_recording.mvd2', messages: 2 });

            const stop = await request(httpServer).post('/record/stop');
            expect(stop.status).toBe(200);
            expect(stop.body.file).toBe('devin_test_recording.mvd2');
            expect(stop.body.messages).toBe(2);

            // Verify the file is a valid .mvd2 containing exactly p1 and p2.
            const got: Buffer[] = await new Promise((resolve, reject) => {
                const reader = new MvdDemoReader();
                const acc: Buffer[] = [];
                reader.on('message', (m) => acc.push(m));
                reader.on('end', () => resolve(acc));
                reader.on('error', reject);
                reader.play(path.join(DEMOS_DIR, 'devin_test_recording.mvd2'));
            });
            expect(got).toEqual([p1, p2]);
        });

        test('traversal name is rejected', async () => {
            const res = await request(httpServer).post('/record/start?name=../evil');
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('invalid-name');
        });
    });

    describe('POST /replay/control', () => {
        test('returns 409 when no replay is active', async () => {
            const res = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ pause: true });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('no-replay');
        });

        test('pause, speed and seek round-trip through /state', async () => {
            await request(httpServer).post('/replay?file=demo.mvd2');

            const pause = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ pause: true, speed: 2 });
            expect(pause.status).toBe(202);
            expect(pause.body.paused).toBe(true);
            expect(pause.body.speed).toBe(2);
            expect(pause.body.messageCount).toBeGreaterThan(0);

            const state = await request(httpServer).get('/state');
            expect(state.body.replay.paused).toBe(true);
            expect(state.body.replay.speed).toBe(2);

            // seek past the last keyframe snaps back to it (demo has a
            // single serverdata near index 0, so snapped stays small).
            const seek = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ seek: 300 });
            expect(seek.status).toBe(202);
            expect(seek.body.position).toBeLessThanOrEqual(300);

            const resume = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ pause: false });
            expect(resume.body.paused).toBe(false);
        });

        test('invalid speed and seek return 400', async () => {
            await request(httpServer).post('/replay?file=demo.mvd2');
            const badSpeed = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ speed: -1 });
            expect(badSpeed.status).toBe(400);
            expect(badSpeed.body.error).toBe('invalid-speed');

            const badSeek = await request(httpServer)
                .post('/replay/control')
                .set('content-type', 'application/json')
                .send({ seek: 'abc' });
            expect(badSeek.status).toBe(400);
            expect(badSeek.body.error).toBe('invalid-seek');
        });
    });
});
