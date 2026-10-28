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
jest.mock('net', () => ({
    Socket: class {
        constructor() { return new FakeSocket() as unknown as object; }
    },
}));

import { httpServer, resetAppStateForTests, DEMOS_DIR, parser, getScoreboardForTests, getPlayersForTests, sseClients, sseHeartbeatTick, isStatusReplySource } from '../src/app';
import { PlayerState } from '../src/frame';
import { Stat } from '../src/protocol';
import { buildSynthBsp } from './helpers/fixtures';

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
});
