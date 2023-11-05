import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { Database } from 'sqlite3';
import { KvError_BD_NotFound } from '../types';

export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    private readonly database: Database;

    constructor(
        blockSize: number,
        dataBasePath: Database,
    ) {
        super(blockSize);
        this.database = dataBasePath;
    }

    public async init(): Promise<this> {
        await super.init();

        await new Promise<void>((resolve, reject) => {
            this.database.run(
                'CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, data BLOB)',
                (err) => err ? reject(err) : resolve());
        });

        return this;
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.ensureInit();

        return new Promise((resolve, reject) => {
            this.database.get(
                'SELECT data FROM blocks WHERE id = ?', [blockId],
                (err, row: { data: string }) => {
                    if (err) {
                        reject(err);
                    } else if (!row) {
                        reject(new KvError_BD_NotFound(`Block "${blockId}" not found.`));
                    } else {
                        resolve(Buffer.from(row.data));
                    }
                });
        });
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.ensureInit();

        return new Promise<void>((resolve, reject) => {
            this.database.run(
                `INSERT OR REPLACE INTO blocks (id, data) VALUES (?, ?)`, [blockId, data],
                (err) => err ? reject(err) : resolve());
        });
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.ensureInit();

        return new Promise<void>((resolve, reject) => {
            this.database.run(
                'DELETE FROM blocks WHERE id = ?', [blockId],
                (err) => err ? reject(err) : resolve());
        });
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        this.ensureInit();

        return new Promise<boolean>((resolve, reject) => {
            this.database.get(
                'SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ? LIMIT 1) AS E', [blockId],
                (err, row: { E: boolean }) => err ? reject(err) : resolve(row.E));
        });
    }

    public async getNextINodeId(): Promise<INodeId> {
        this.ensureInit();

        return new Promise<INodeId>((resolve, reject) => {
            this.database.get(
                'SELECT MAX(id) AS maxId FROM blocks',
                (err, row: { maxId: number }) => err ? reject(err) : resolve(row.maxId + 1));
        });
    }
}
