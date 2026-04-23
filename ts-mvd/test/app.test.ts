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

import { httpServer, resetAppStateForTests, DEMOS_DIR } from '../src/app';

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
