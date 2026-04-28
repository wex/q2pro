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

import { httpServer, resetAppStateForTests, DEMOS_DIR, parser, getScoreboardForTests } from '../src/app';
import { PlayerState } from '../src/frame';

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
            .send({ host: 'fake.local', port: 27910 });
        expect(res.status).toBe(202);
        expect(res.body.host).toBe('fake.local');
        expect(res.body.port).toBe(27910);

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
        expect(postRes.body.file).toBe(path.join(DEMOS_DIR, 'demo.mvd2'));

        const state = await request(httpServer).get('/state');
        expect(state.body.mode).toBe('replay');
        expect(state.body.replayFile).toBe(path.join(DEMOS_DIR, 'demo.mvd2'));

        const del = await request(httpServer).delete('/replay');
        expect(del.status).toBe(204);

        const after = await request(httpServer).get('/state');
        expect(after.body.mode).toBe('idle');
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
        const mkPlayer = (number: number, frags: number): PlayerState => ({
            number,
            inUse: true,
            pmType: 0,
            origin: [0, 0, 0],
            viewangles: [0, 0, 0],
            viewoffset: [0, 0, 0],
            fov: 90,
            gunindex: 0,
            rdflags: 0,
            frags,
            stats: new Int16Array(32),
            isMvdDummy: false,
        });

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

    test('scoreboard drops a player when their playerskin configstring is cleared', () => {
        const mkPlayer = (number: number, frags: number): PlayerState => ({
            number,
            inUse: true,
            pmType: 0,
            origin: [0, 0, 0],
            viewangles: [0, 0, 0],
            viewoffset: [0, 0, 0],
            fov: 90,
            gunindex: 0,
            rdflags: 0,
            frags,
            stats: new Int16Array(32),
            isMvdDummy: false,
        });

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

    test('scoreboard skips MVD dummy slot (isMvdDummy=true)', () => {
        const mkPlayer = (number: number, frags: number, isMvdDummy = false): PlayerState => ({
            number,
            inUse: true,
            pmType: 0,
            origin: [0, 0, 0],
            viewangles: [0, 0, 0],
            viewoffset: [0, 0, 0],
            fov: 90,
            gunindex: 0,
            rdflags: 0,
            frags,
            stats: new Int16Array(32),
            isMvdDummy,
        });

        parser.onFrame!({
            frameNumber: 1,
            players: [mkPlayer(0, 3), mkPlayer(7, 0, true), mkPlayer(1, 5)],
            teamScores: { team1: 0, team2: 0, team3: 0 },
            layoutsFlags: 0,
        });

        const sb = getScoreboardForTests();
        expect(sb.players[0]).toEqual({ number: 0, frags: 3 });
        expect(sb.players[1]).toEqual({ number: 1, frags: 5 });
        expect(sb.players[7]).toBeUndefined();
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
});
