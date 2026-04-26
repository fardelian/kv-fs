import { describe, it, expect, jest } from 'test-globals';
import { KvBlockDeviceSqlite3 } from './kv-block-device-sqlite3';
import { KvError_BD_NotFound } from '../utils';
import type { AsyncDatabase } from 'promised-sqlite3';

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 64;
const TABLE_NAME = 'blocks';

/**
 * Fake `AsyncDatabase`. Only `run` and `get` are exercised by
 * `KvBlockDeviceSqlite3`, so we expose them as `jest.fn`s and don't bother
 * implementing the rest of the AsyncDatabase surface.
 */
class FakeDatabase {
    public run = jest.fn<(sql: string, ...params: unknown[]) => Promise<unknown>>();
    public get = jest.fn<(sql: string, ...params: unknown[]) => Promise<unknown>>();
}

function makeDevice(database: FakeDatabase = new FakeDatabase()): {
    database: FakeDatabase;
    device: KvBlockDeviceSqlite3;
} {
    const device = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        CAPACITY_BYTES,
        database as unknown as AsyncDatabase,
        TABLE_NAME,
    );
    return { database, device };
}

describe('KvBlockDeviceSqlite3', () => {
    describe('constructor: tableName validation', () => {
        const make = (tableName: string) => () => new KvBlockDeviceSqlite3(
            BLOCK_SIZE,
            CAPACITY_BYTES,
            new FakeDatabase() as unknown as AsyncDatabase,
            tableName,
        );

        it.each([
            ['blocks'],
            ['Blocks'],
            ['_underscore_lead'],
            ['x9'],
            ['ALL_CAPS_42'],
        ])('accepts safe identifier %j', (tableName) => {
            expect(make(tableName)).not.toThrow();
        });

        it.each([
            [''],
            ['9starts_with_digit'],
            ['has space'],
            ['has-dash'],
            ['"quoted"'],
            ['blocks; DROP TABLE users; --'],
            ['blocks/*comment*/'],
        ])('rejects unsafe identifier %j', (tableName) => {
            expect(make(tableName)).toThrow(/Invalid SQLite tableName/);
        });
    });

    describe('init', () => {
        it('creates the table if it does not exist', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);

            await device.init();

            expect(database.run).toHaveBeenCalledTimes(1);
            expect(database.run).toHaveBeenCalledWith(
                `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, data BLOB)`,
            );
        });
    });

    describe('readBlock', () => {
        it('returns the bytes of the row at id', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            const stored = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
            database.get.mockResolvedValueOnce({ data: stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength) });

            const result = await device.readBlock(7);

            expect(database.get).toHaveBeenCalledWith(
                `SELECT data FROM ${TABLE_NAME} WHERE id = ?`,
                7,
            );
            expect(Array.from(result)).toEqual([0xde, 0xad, 0xbe, 0xef]);
        });

        it('throws KvError_BD_NotFound when no row exists at id', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce(undefined);

            await expect(device.readBlock(99)).rejects.toBeInstanceOf(KvError_BD_NotFound);
        });
    });

    describe('writeBlock', () => {
        it('issues INSERT OR REPLACE with id and a Buffer view of the data', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            database.run.mockResolvedValueOnce(undefined); // write

            const data = new Uint8Array([1, 2, 3, 4, 5]);
            await device.writeBlock(3, data);

            expect(database.run).toHaveBeenLastCalledWith(
                `INSERT OR REPLACE INTO ${TABLE_NAME} (id, data) VALUES (?, ?)`,
                3,
                expect.any(Buffer),
            );
            const blob = database.run.mock.calls[1][2] as Buffer;
            expect(Array.from(blob)).toEqual([1, 2, 3, 4, 5]);
        });
    });

    describe('freeBlock', () => {
        it('issues DELETE FROM <table> WHERE id = ?', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            database.run.mockResolvedValueOnce(undefined);

            await device.freeBlock(4);

            expect(database.run).toHaveBeenLastCalledWith(
                `DELETE FROM ${TABLE_NAME} WHERE id = ?`,
                4,
            );
        });
    });

    describe('existsBlock', () => {
        it('returns true when EXISTS subquery returns 1', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ E: 1 });

            expect(await device.existsBlock(2)).toBe(true);
            expect(database.get).toHaveBeenLastCalledWith(
                `SELECT EXISTS(SELECT 1 FROM ${TABLE_NAME} WHERE id = ? LIMIT 1) AS E`,
                2,
            );
        });

        it('returns false when EXISTS subquery returns 0', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ E: 0 });

            expect(await device.existsBlock(2)).toBe(false);
        });

        it('returns false when SQLite returns nothing (defensive)', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce(undefined);

            expect(await device.existsBlock(2)).toBe(false);
        });
    });

    describe('allocateBlock', () => {
        it('returns 0 on an empty table (MAX(id) is null)', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ maxId: null });

            expect(await device.allocateBlock()).toBe(0);
        });

        it('returns max(id) + 1 when rows exist', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ maxId: 41 });

            expect(await device.allocateBlock()).toBe(42);
        });

        it('returns 0 when SQLite returns nothing (defensive)', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce(undefined);

            expect(await device.allocateBlock()).toBe(0);
        });
    });

    describe('getHighestBlockId', () => {
        it('returns -1 on an empty table', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ maxId: null });

            expect(await device.getHighestBlockId()).toBe(-1);
        });

        it('returns the max id when rows exist', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce({ maxId: 99 });

            expect(await device.getHighestBlockId()).toBe(99);
        });

        it('returns -1 when SQLite returns nothing (defensive)', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce(undefined);

            expect(await device.getHighestBlockId()).toBe(-1);
        });
    });

    describe('format', () => {
        it('drops and re-creates the table', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            database.run.mockResolvedValueOnce(undefined); // drop
            database.run.mockResolvedValueOnce(undefined); // create

            await device.format();

            // After init's CREATE, format issues DROP then CREATE.
            const calls = database.run.mock.calls.map((c) => c[0]);
            expect(calls[1]).toBe(`DROP TABLE IF EXISTS ${TABLE_NAME}`);
            expect(calls[2]).toBe(
                `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (id INTEGER PRIMARY KEY, data BLOB)`,
            );
        });
    });
});
