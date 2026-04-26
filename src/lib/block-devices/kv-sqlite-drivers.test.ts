import { describe, it, expect, jest } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { AsyncDatabase } from 'promised-sqlite3';
import { wrapAsyncDatabase, wrapBunSqliteDatabase } from './kv-sqlite-drivers';

describe('wrapBunSqliteDatabase', () => {
    function makeTable(): Database {
        // `:memory:` keeps the test self-contained; the wrapper has to
        // exercise the real bun:sqlite API, not a mock, because the
        // adapter exists specifically to bridge that API's shape.
        const db = new Database(':memory:');
        db.run('CREATE TABLE kv (id INTEGER PRIMARY KEY, value TEXT)');
        return db;
    }

    it('run() executes a parameterised statement', async () => {
        const db = makeTable();
        const driver = wrapBunSqliteDatabase(db);

        await driver.run('INSERT INTO kv (id, value) VALUES (?, ?)', 1, 'hello');

        // Verify via the wrapper's `get` (the path the production code
        // uses) — sidesteps the bun:sqlite Statement-typing quirks of
        // a direct `.prepare(...).get(1)` call.
        const row = await driver.get<{ value: string }>('SELECT value FROM kv WHERE id = ?', 1);
        expect(row?.value).toBe('hello');
    });

    it('get() returns the first row when one matches', async () => {
        const db = makeTable();
        const driver = wrapBunSqliteDatabase(db);
        // Seed via the wrapper so the test stays inside the typed surface.
        await driver.run('INSERT INTO kv (id, value) VALUES (?, ?)', 7, 'seven');

        const row = await driver.get<{ value: string }>('SELECT value FROM kv WHERE id = ?', 7);
        expect(row?.value).toBe('seven');
    });

    it('get() normalises bun:sqlite null misses to undefined', async () => {
        const db = makeTable();
        const driver = wrapBunSqliteDatabase(db);

        const row = await driver.get<{ value: string }>('SELECT value FROM kv WHERE id = ?', 99);
        expect(row).toBeUndefined();
    });

    it('close() closes the underlying database', async () => {
        const db = makeTable();
        const driver = wrapBunSqliteDatabase(db);

        await driver.close();
        // Driving the wrapper after close throws — verifies the underlying
        // bun:sqlite Database really shut down rather than just being
        // GC-eligible.
        await expect(driver.get('SELECT 1')).rejects.toThrow();
    });
});

describe('wrapAsyncDatabase', () => {
    /**
     * Minimal AsyncDatabase fake. We only stub the three methods our
     * wrapper actually touches; using a mocked shape keeps the test
     * independent of npm `sqlite3` having a compiled binding (the
     * whole reason the driver indirection exists).
     */
    function makeFake() {
        const fake = {
            run: jest.fn<(sql: string, ...params: unknown[]) => Promise<unknown>>(),
            get: jest.fn<(sql: string, ...params: unknown[]) => Promise<unknown>>(),
            close: jest.fn<() => Promise<void>>(),
        };
        return fake;
    }

    it('run() awaits the underlying run and discards the RunResult', async () => {
        const fake = makeFake();
        fake.run.mockResolvedValueOnce({ changes: 1, lastID: 1 });
        const driver = wrapAsyncDatabase(fake as unknown as AsyncDatabase);

        const result = await driver.run('UPDATE kv SET v = ?', 7);

        expect(result).toBeUndefined();
        expect(fake.run).toHaveBeenCalledWith('UPDATE kv SET v = ?', 7);
    });

    it('get() forwards the typed SELECT through', async () => {
        const fake = makeFake();
        fake.get.mockResolvedValueOnce({ value: 'hi' });
        const driver = wrapAsyncDatabase(fake as unknown as AsyncDatabase);

        const row = await driver.get<{ value: string }>('SELECT value FROM kv WHERE id = ?', 1);

        expect(row?.value).toBe('hi');
        expect(fake.get).toHaveBeenCalledWith('SELECT value FROM kv WHERE id = ?', 1);
    });

    it('close() awaits the underlying close', async () => {
        const fake = makeFake();
        fake.close.mockResolvedValueOnce(undefined);
        const driver = wrapAsyncDatabase(fake as unknown as AsyncDatabase);

        await driver.close();
        expect(fake.close).toHaveBeenCalledTimes(1);
    });
});
