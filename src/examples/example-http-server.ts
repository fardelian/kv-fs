import { KvBlockDeviceFs, KvBlockDeviceExpressRouter, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionNone } from '../lib/encryption';
import express from 'express';
import { mkdirSync } from 'fs';

const BLOCK_SIZE = 4096;
const PORT = 3000;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const encryption = new KvEncryptionNone();

    const serverBlockDevice = new KvBlockDeviceFs(
        BLOCK_SIZE,
        LOCAL_FS_PATH,
    );
    await serverBlockDevice.init();

    const encryptedServerBlockDevice = new KvEncryptedBlockDevice(serverBlockDevice, encryption);
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
