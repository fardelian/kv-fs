import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { AsyncDatabase } from 'promised-sqlite3';
import { Init, KvError_BD_NotFound } from '../utils';

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
        // sqlite3 expects a Buffer for BLOB params; wrap as a zero-copy view.
        const blob = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        await this.database.run(
            `INSERT OR REPLACE INTO ${this.tableName} (id, data) VALUES (?, ?)`,
            blockId,
            blob,
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
