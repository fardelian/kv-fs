import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode';
import { Database } from 'sqlite3';
import { Init } from '../utils/init';
import { KvError_BD_NotFound } from '../utils/errors';

export class KvBlockDeviceSqlite3 extends KvBlockDevice {
    private readonly database: Database;

    constructor(
        blockSize: number,
        dataBasePath: Database,
    ) {
        super(blockSize);
        this.database = dataBasePath;
    }

    public async init(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.database.run(
                'CREATE TABLE IF NOT EXISTS blocks (id INTEGER PRIMARY KEY, data BLOB)',
                (err) => err ? reject(err) : resolve());
        });
    }

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
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

    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        // sqlite3 expects a Buffer for BLOB params; wrap as a zero-copy view.
        const blob = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return new Promise<void>((resolve, reject) => {
            this.database.run(
                `INSERT OR REPLACE INTO blocks (id, data) VALUES (?, ?)`, [blockId, blob],
                (err) => err ? reject(err) : resolve());
        });
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.database.run(
                'DELETE FROM blocks WHERE id = ?', [blockId],
                (err) => err ? reject(err) : resolve());
        });
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            this.database.get(
                'SELECT EXISTS(SELECT 1 FROM blocks WHERE id = ? LIMIT 1) AS E', [blockId],
                (err, row: { E: boolean }) => err ? reject(err) : resolve(row.E));
        });
    }

    @Init
    public async allocateBlock(): Promise<INodeId> {
        return new Promise<INodeId>((resolve, reject) => {
            this.database.get(
                'SELECT MAX(id) AS maxId FROM blocks',
                (err, row: { maxId: number }) => err ? reject(err) : resolve(row.maxId + 1));
        });
    }
}
