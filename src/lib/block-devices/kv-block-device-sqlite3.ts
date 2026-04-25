import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { AsyncDatabase } from 'promised-sqlite3';
import { Init, KvError_BD_NotFound } from '../utils';

export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    private readonly database: AsyncDatabase;
    private readonly tableName: string;

    constructor(
        blockSize: number,
        capacityBlocks: number,
        database: AsyncDatabase,
        tableName: string,
    ) {
        super(blockSize, capacityBlocks);
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
