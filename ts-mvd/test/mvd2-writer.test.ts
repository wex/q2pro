import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Mvd2Writer } from '../src/mvd2-writer';
import { MvdDemoReader } from '../src/demo';
import { MvdOp } from '../src/protocol';

describe('Mvd2Writer', () => {
    let tmpDir: string;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvd2-writer-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function readMessages(file: string): Promise<Buffer[]> {
        return new Promise((resolve, reject) => {
            const reader = new MvdDemoReader();
            const got: Buffer[] = [];
            reader.on('message', (m) => got.push(m));
            reader.on('end', () => resolve(got));
            reader.on('error', reject);
            reader.play(file);
        });
    }

    test('round-trips payloads through MvdDemoReader', async () => {
        const file = path.join(tmpDir, 'out.mvd2');
        const w = new Mvd2Writer();
        w.open(file);
        const payloads = [
            Buffer.from([MvdOp.Nop]),
            Buffer.from([MvdOp.Print, 1, 0x68, 0x69, 0]),
            Buffer.from([MvdOp.Sound, 0, 42, 8]),
        ];
        for (const p of payloads) w.writeMessage(p);
        const fin = w.close();
        expect(fin).toEqual({
            file,
            messages: 3,
            bytes: 4 + payloads.length * 2 + payloads.reduce((s, p) => s + p.length, 0) + 2,
        });

        const got = await readMessages(file);
        expect(got).toEqual(payloads);
    });

    test('skips empty payloads (wire suspend marker == .mvd2 EOF marker)', async () => {
        const file = path.join(tmpDir, 'empty.mvd2');
        const w = new Mvd2Writer();
        w.open(file);
        w.writeMessage(Buffer.from([MvdOp.Nop]));
        w.writeMessage(Buffer.alloc(0)); // suspend marker — must not become EOF
        w.writeMessage(Buffer.from([MvdOp.Nop]));
        w.close();
        expect(w.messages).toBe(2);

        const got = await readMessages(file);
        expect(got).toHaveLength(2);
    });

    test('close() is a no-op when idle; open() rejects double-open', () => {
        const w = new Mvd2Writer();
        expect(w.recording).toBe(false);
        expect(w.close()).toBeNull();

        w.open(path.join(tmpDir, 'a.mvd2'));
        expect(w.recording).toBe(true);
        expect(() => w.open(path.join(tmpDir, 'b.mvd2'))).toThrow(/already recording/);
        w.close();
    });

    test('creates missing parent directories', () => {
        const file = path.join(tmpDir, 'nested', 'deep', 'x.mvd2');
        const w = new Mvd2Writer();
        w.open(file);
        w.close();
        expect(fs.existsSync(file)).toBe(true);
        // Header + EOF marker only.
        expect(fs.statSync(file).size).toBe(6);
    });
});
