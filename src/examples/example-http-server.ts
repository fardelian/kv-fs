import {
    KvBlockDeviceHttpRouter,
    KvEncryptedBlockDevice,
    KvBlockDeviceSqlite3,
} from '../lib/block-devices';
import { KvEncryptionRot13 } from '../lib/encryption';
import express from 'express';
import { mkdirSync } from 'fs';
import { Database } from 'sqlite3';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const PORT = 3000;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const encryption = new KvEncryptionRot13();

    // Create backend block device (encrypted, using sqlite)

    const database = await new Promise<Database>((resolve, reject) => {
        const db: Database = new Database(`${LOCAL_FS_PATH}/data.sqlite3`, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve(db);
            }
        });
    });

    const sqliteBlockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        database,
    );

    const encryptedServerBlockDevice = new KvEncryptedBlockDevice(sqliteBlockDevice, encryption);

    // Create express router mapping HTTP endpoints to block device operations

    const router = express.Router();
    const bdRouter = new KvBlockDeviceHttpRouter();
    bdRouter.route(encryptedServerBlockDevice, router);

    // Start express app

    const server = express();
    server.use(express.json());
    server.use(router);

    await new Promise<void>((resolve) => {
        server.listen(PORT, () => {
            console.log(`Server is listening on :${PORT}`);
            resolve();
        });
    });
}

run().catch(console.error);
