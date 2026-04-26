import { KvBlockDevice } from '../helpers/kv-block-device';
import { INodeId } from '../../inode';
import { AsyncDatabase } from 'promised-sqlite3';
import { Init, KvError_BD_NotFound, KvError_BD_Overflow } from '../../utils';

/**
 * `KvBlockDevice` backed by a SQLite3 table. One row per block, keyed
 * by integer ID. Short writes are zero-padded up to `blockSize` so the
 * stored BLOB matches the device's contract that every read returns
 * exactly `blockSize` bytes — same behaviour as the in-memory and FS
 * backends.
 */
export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    /**
     * SQLite cannot parameterize identifiers, so `tableName` is interpolated
     * into every statement we issue. Restrict it to a safe identifier shape
     * so a caller cannot smuggle SQL through it.
     */
    private static readonly TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

    private readonly database: AsyncDatabase;
    private readonly tableName: string;

    constructor(
        blockSize: number,
        capacityBytes: number,
        database: AsyncDatabase,
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

        this.database = database;
        this.tableName = tableName;
    }

    /** Create the blocks table if it doesn't exist. Idempotent. */
    async init(): Promise<void> {
        await this.database.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (id INTEGER PRIMARY KEY, data BLOB)`,
        );
    }

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const row = await this.database.get<{ data: ArrayBufferLike } | undefined>(
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
        await this.database.run(
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
        const row = await this.database.get<{ data: ArrayBufferLike } | undefined>(
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
        await this.database.run(
            `UPDATE ${this.tableName} SET data = substr(data, 1, ?) || ? || substr(data, ?) WHERE id = ?`,
            offset,
            blob,
            offset + data.length + 1,
            blockId,
        );
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        await this.database.run(`DELETE FROM ${this.tableName} WHERE id = ?`, blockId);
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const row = await this.database.get<{ E: 0 | 1 } | undefined>(
            `SELECT EXISTS(SELECT 1 FROM ${this.tableName} WHERE id = ? LIMIT 1) AS E`,
            blockId,
        );
        return row?.E === 1;
    }

    @Init
    public async allocateBlock(): Promise<INodeId> {
        const row = await this.database.get<{ maxId: number | null } | undefined>(
            `SELECT MAX(id) AS maxId FROM ${this.tableName}`,
        );
        return (row?.maxId ?? -1) + 1;
    }

    @Init
    public async getHighestBlockId(): Promise<INodeId> {
        // SQLite's MAX(id) returns null on an empty table; fold to -1 so
        // the wire-level contract is "always a number".
        const row = await this.database.get<{ maxId: number | null } | undefined>(
            `SELECT MAX(id) AS maxId FROM ${this.tableName}`,
        );
        return row?.maxId ?? -1;
    }

    @Init
    public async format(): Promise<void> {
        // Drop + recreate is faster than DELETE FROM for a wipe and
        // resets the table's autoincrement state too.
        await this.database.run(`DROP TABLE IF EXISTS ${this.tableName}`);
        await this.database.run(
            `CREATE TABLE IF NOT EXISTS ${this.tableName} (id INTEGER PRIMARY KEY, data BLOB)`,
        );
    }
}
