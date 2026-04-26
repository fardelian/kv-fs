import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { Init, KvError_BD_NotFound, KvError_BD_Overflow } from '../utils';

/**
 * Minimal async SQLite surface that {@link KvBlockDeviceSqlite3}
 * actually depends on. Every backend the kv-fs runs on top of (Bun's
 * native `bun:sqlite`, the `promised-sqlite3` wrapper around the npm
 * `sqlite3` package, an in-memory fake for tests, …) is one of these.
 *
 * - `run`  — execute a statement that returns no rows (DDL, INSERT,
 *            UPDATE, DELETE).
 * - `get`  — execute a SELECT and return the first row, or `undefined`
 *            when no row matches. The cast site picks the row shape.
 * - `close` — release the underlying connection. Used by examples on
 *            graceful shutdown; the block-device class itself never
 *            invokes it.
 *
 * Adapter factories for the two real-world backends live in
 * [`kv-sqlite-drivers.ts`](kv-sqlite-drivers.ts).
 */
export interface KvSqliteDriver {
    run(sql: string, ...params: unknown[]): Promise<void>;
    get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    close(): Promise<void>;
}

/**
 * `KvBlockDevice` backed by a SQLite table. One row per block, keyed
 * by integer ID. Short writes are zero-padded up to `blockSize` so the
 * stored BLOB matches the device's contract that every read returns
 * exactly `blockSize` bytes — same behaviour as the in-memory and FS
 * backends.
 *
 * The constructor takes a {@link KvSqliteDriver} rather than a
 * specific SQLite client, so the same block device works against
 * `bun:sqlite` (under Bun) and `promised-sqlite3` / npm `sqlite3`
 * (under Node). Wrap whichever raw client you have via the helpers
 * in [`kv-sqlite-drivers.ts`](kv-sqlite-drivers.ts).
 */
export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    /**
     * SQLite cannot parameterize identifiers, so `tableName` is interpolated
     * into every statement we issue. Restrict it to a safe identifier shape
     * so a caller cannot smuggle SQL through it.
     */
    private static readonly TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

    private readonly driver: KvSqliteDriver;
    private readonly tableName: string;

    constructor(
        blockSize: number,
        capacityBytes: number,
        driver: KvSqliteDriver,
        tableName: string,
    ) {
        super(blockSize, capacityBytes);

        if (!KvBlockDeviceSqlite3.TABLE_NAME_PATTERN.test(tableName)) {
            throw new Error(
                `Invalid SQLite tableName "${tableName}". `
                + `SQLite cannot parameterize table identifiers, so the name `
                + `is interpolated directly into SQL. To prevent injection, `
                + `tableName must match ${KvBlockDeviceSqlite3.TABLE_NAME_PATTERN.toString()} `
                + `(start with a letter or underscore, then letters/digits/underscores).`,
            );
        }

        this.driver = driver;
        this.tableName = tableName;
    }

    /** Create the blocks table if it doesn't exist. Idempotent. */
    async init(): Promise<void> {
        await this.driver.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (id INTEGER PRIMARY KEY, data BLOB)`,
        );
    }

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const row = await this.driver.get<{ data: ArrayBufferLike }>(
            `SELECT data FROM ${this.tableName} WHERE id = ?`,
            blockId,
        );
        if (!row) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        return new Uint8Array(row.data);
    }

    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }
        // Zero-pad short writes up to blockSize so reads always return
        // exactly `blockSize` bytes — matching the FS / memory backends.
        const padded = new Uint8Array(this.getBlockSize());
        padded.set(data);
        const blob = Buffer.from(padded.buffer, padded.byteOffset, padded.byteLength);
        await this.driver.run(
            `INSERT OR REPLACE INTO ${this.tableName} (id, data) VALUES (?, ?)`,
            blockId,
            blob,
        );
    }

    /**
     * Read `[start, end)` from the block via SQLite's `substr` so only
     * the requested bytes leave the database (BLOBs are 1-indexed and
     * `substr(blob, start, length)`-shaped).
     */
    @Init
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) return new Uint8Array(0);
        const length = end - start;
        const row = await this.driver.get<{ data: ArrayBufferLike }>(
            `SELECT substr(data, ?, ?) AS data FROM ${this.tableName} WHERE id = ?`,
            start + 1,
            length,
            blockId,
        );
        if (!row) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        return new Uint8Array(row.data);
    }

    /**
     * Splice `data` into the existing BLOB at byte `offset` using SQL
     * concatenation. Faster than read-modify-write at the JS layer for
     * short writes; SQLite handles the surrounding-bytes preservation.
     */
    @Init
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        if (data.length === 0) return;
        if (offset + data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(offset + data.length, this.getBlockSize());
        }
        const exists = await this.existsBlock(blockId);
        if (!exists) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        const blob = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        // substr(data, 1, offset) keeps the prefix, then the new bytes,
        // then substr from offset+length+1 onwards keeps the suffix.
        await this.driver.run(
            `UPDATE ${this.tableName} SET data = substr(data, 1, ?) || ? || substr(data, ?) WHERE id = ?`,
            offset,
            blob,
            offset + data.length + 1,
            blockId,
        );
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        await this.driver.run(`DELETE FROM ${this.tableName} WHERE id = ?`, blockId);
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const row = await this.driver.get<{ E: 0 | 1 }>(
            `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE id = ? LIMIT 1) AS E`,
            blockId,
        );
        return row?.E === 1;
    }

    @Init
    public async allocateBlock(): Promise<INodeId> {
        const row = await this.driver.get<{ maxId: number | null }>(
            `SELECT MAX(id) AS maxId FROM ${this.tableName}`,
        );
        return (row?.maxId ?? -1) + 1;
    }

    @Init
    public async getHighestBlockId(): Promise<INodeId> {
        // SQLite's MAX(id) returns null on an empty table; fold to -1 so
        // the wire-level contract is "always a number".
        const row = await this.driver.get<{ maxId: number | null }>(
            `SELECT MAX(id) AS maxId FROM ${this.tableName}`,
        );
        return row?.maxId ?? -1;
    }

    @Init
    public async format(): Promise<void> {
        // Drop + recreate is faster than DELETE FROM for a wipe and
        // resets the table's autoincrement state too.
        await this.driver.run(`DROP TABLE IF EXISTS ${this.tableName}`);
        await this.driver.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (id INTEGER PRIMARY KEY, data BLOB)`,
        );
    }
}
