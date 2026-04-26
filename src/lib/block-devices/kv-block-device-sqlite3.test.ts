import { describe, it, expect, jest } from 'bun:test';
import { KvBlockDeviceSqlite3, KvSqliteDriver } from './kv-block-device-sqlite3';
import { KvError_BD_NotFound, KvError_BD_Overflow } from '../utils';

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 64;
const TABLE_NAME = 'blocks';

/**
 * Fake {@link KvSqliteDriver}. The block device only ever talks to
 * `run` / `get` — `close` is here for completeness and to satisfy
 * the interface, never invoked from the device itself.
 *
 * (`database` is the historical name still used by the assertions
 * below — it's just the driver mock.)
 *
 * `get` is widened to `<T>(...) => Promise<T | undefined>` via a cast
 * so a single `jest.fn` can stand in for the generic signature on the
 * interface. `mockResolvedValueOnce(row)` works against any concrete
 * row type — the cast just lets TypeScript see the generic shape.
 */
class FakeDatabase implements KvSqliteDriver {
    public run = jest.fn<(sql: string, ...params: unknown[]) => Promise<void>>();
    public get = jest.fn<(sql: string, ...params: unknown[]) => Promise<unknown>>() as
        unknown as KvSqliteDriver['get'] & jest.Mock<(sql: string, ...params: unknown[]) => Promise<unknown>>;

    public close = jest.fn<() => Promise<void>>();
}

function makeDevice(database: FakeDatabase = new FakeDatabase()): {
    database: FakeDatabase;
    device: KvBlockDeviceSqlite3;
} {
    const device = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        CAPACITY_BYTES,
        database,
        TABLE_NAME,
    );
    return { database, device };
}

describe('KvBlockDeviceSqlite3', () => {
    describe('constructor: tableName validation', () => {
        const make = (tableName: string) => () => new KvBlockDeviceSqlite3(
            BLOCK_SIZE,
            CAPACITY_BYTES,
            new FakeDatabase(),
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
        it('issues INSERT OR REPLACE with id and a Buffer padded to blockSize', async () => {
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
            // Short writes are zero-padded up to blockSize so reads always
            // return exactly `blockSize` bytes (matches FS / memory backends).
            expect(blob.length).toBe(BLOCK_SIZE);
            expect(Array.from(blob.subarray(0, 5))).toEqual([1, 2, 3, 4, 5]);
            for (let i = 5; i < BLOCK_SIZE; i++) {
                expect(blob[i]).toBe(0);
            }
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

    describe('writeBlock overflow', () => {
        it('throws KvError_BD_Overflow when data exceeds blockSize', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init

            await expect(device.writeBlock(0, new Uint8Array(BLOCK_SIZE + 1)))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });
    });

    describe('readBlockPartial', () => {
        it('issues SELECT substr(data, ?, ?) and returns the slice bytes', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            const slice = new Uint8Array([0xa, 0xb, 0xc, 0xd]);
            database.get.mockResolvedValueOnce({ data: slice.buffer });

            const out = await device.readBlockPartial(7, 100, 104);

            expect(database.get).toHaveBeenLastCalledWith(
                // SQLite substr is 1-indexed; start=100 → param=101.
                `SELECT substr(data, ?, ?) AS data FROM ${TABLE_NAME} WHERE id = ?`,
                101,
                4,
                7,
            );
            expect(Array.from(out)).toEqual([0xa, 0xb, 0xc, 0xd]);
        });

        it('returns an empty buffer without querying when end <= start', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init

            const out = await device.readBlockPartial(0, 5, 5);

            expect(out.length).toBe(0);
            // Only the init CREATE was issued; no SELECT.
            expect(database.get).not.toHaveBeenCalled();
        });

        it('throws KvError_BD_NotFound when no row matches the id', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined);
            database.get.mockResolvedValueOnce(undefined);

            await expect(device.readBlockPartial(99, 0, 4))
                .rejects.toBeInstanceOf(KvError_BD_NotFound);
        });
    });

    describe('writeBlockPartial', () => {
        it('splices the data into the existing BLOB via substr concatenation', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            database.get.mockResolvedValueOnce({ E: 1 }); // existsBlock
            database.run.mockResolvedValueOnce(undefined); // UPDATE

            const data = new Uint8Array([0xff, 0xee]);
            await device.writeBlockPartial(3, 50, data);

            const lastCall = database.run.mock.calls[database.run.mock.calls.length - 1];
            expect(lastCall[0]).toBe(
                `UPDATE ${TABLE_NAME} SET data = substr(data, 1, ?) || ? || substr(data, ?) WHERE id = ?`,
            );
            expect(lastCall[1]).toBe(50);
            expect(lastCall[2]).toBeInstanceOf(Buffer);
            expect(Array.from(lastCall[2] as Buffer)).toEqual([0xff, 0xee]);
            // suffix-from index: 1-indexed, after offset+length → 50+2+1 = 53.
            expect(lastCall[3]).toBe(53);
            expect(lastCall[4]).toBe(3);
        });

        it('is a no-op when data is empty', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init

            await device.writeBlockPartial(0, 0, new Uint8Array(0));

            // Only the init CREATE was issued.
            expect(database.run).toHaveBeenCalledTimes(1);
            expect(database.get).not.toHaveBeenCalled();
        });

        it('throws KvError_BD_Overflow when offset + data exceeds blockSize', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init

            await expect(device.writeBlockPartial(0, BLOCK_SIZE - 2, new Uint8Array(4)))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });

        it('throws KvError_BD_NotFound when the target row does not exist', async () => {
            const { database, device } = makeDevice();
            database.run.mockResolvedValueOnce(undefined); // init
            database.get.mockResolvedValueOnce({ E: 0 }); // existsBlock → false

            await expect(device.writeBlockPartial(99, 0, new Uint8Array([1])))
                .rejects.toBeInstanceOf(KvError_BD_NotFound);
        });
    });
});
