import {
    KvBlockDeviceFs,
    KvBlockDeviceExpressRouter,
    KvEncryptedBlockDevice,
    KvBlockDeviceSqlite3,
} from '../lib/block-devices';
import { KvEncryptionNone } from '../lib/encryption';
import express from 'express';
import { mkdirSync } from 'fs';
import { Database } from 'sqlite3';

const BLOCK_SIZE = 4096;
const PORT = 3000;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const encryption = new KvEncryptionNone();

    const database = await new Promise<Database>((resolve, reject) => {
        const db = new Database(`${LOCAL_FS_PATH}/data.sqlite3`, (err) => {
            err ? reject(err) : resolve(db);
        });
    });

    const sqliteBlockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        database,
    );
    await sqliteBlockDevice.init();

    const encryptedServerBlockDevice = new KvEncryptedBlockDevice(sqliteBlockDevice, encryption);
    await encryptedServerBlockDevice.init();

    const server = express();
    const router = express.Router();
    const bdRouter = new KvBlockDeviceExpressRouter();
    server.use(express.json());
    bdRouter.route(encryptedServerBlockDevice, router);
    server.use(router);

    return new Promise<void>((resolve) => {
        server.listen(PORT, () => {
            console.log(`Server is listening on :${PORT}`);
            resolve();
        });
    });
}

run().catch(console.error);
