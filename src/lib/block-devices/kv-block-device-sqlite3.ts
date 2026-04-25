import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { Database } from 'sqlite3';
import { promisify } from 'node:util';
import { Init, KvError_BD_NotFound } from '../utils';

type DbRun = (sql: string, params?: unknown[]) => Promise<void>;
type DbGet = <T>(sql: string, params?: unknown[]) => Promise<T | undefined>;

export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    private readonly database: Database;
    private readonly dbRun: DbRun;
    private readonly dbGet: DbGet;

    constructor(
        blockSize: number,
        capacityBytes: number,
        database: Database,
    ) {
        super(blockSize, capacityBytes);
        this.database = database;
        // The field-level DbRun/DbGet annotations pin promisify's overloaded
        // result down to the single signature we actually use (sql + params).
        this.dbRun = promisify(this.database.run.bind(this.database));
        this.dbGet = promisify(this.database.get.bind(this.database));
    }

    protected async init(): Promise<void> {
        await this.dbRun('CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, data BLOB)');
    }

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const row = await this.dbGet<{ data: string }>(
            'SELECT data FROM blocks WHERE id = ?',
            [blockId],
        );
        if (!row) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        return Buffer.from(row.data);
    }

    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        // sqlite3 expects a Buffer for BLOB params; wrap as a zero-copy view.
        const blob = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        await this.dbRun(
            'INSERT OR REPLACE INTO blocks (id, data) VALUES (?, ?)',
            [blockId, blob],
        );
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        await this.dbRun('DELETE FROM blocks WHERE id = ?', [blockId]);
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const row = await this.dbGet<{ E: 0 | 1 }>(
            'SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ? LIMIT 1) AS E',
            [blockId],
        );
        return row?.E === 1;
    }

    @Init
    public async allocateBlock(): Promise<INodeId> {
        const row = await this.dbGet<{ maxId: number | null }>(
            'SELECT MAX(id) AS maxId FROM blocks',
        );
        return (row?.maxId ?? -1) + 1;
    }
}
