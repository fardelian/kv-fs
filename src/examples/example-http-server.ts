import { KvBlockDeviceFs } from '../lib/block-device/kv-block-device-fs';
import { KvEncryptionNone } from '../lib/encryption/kv-encryption-none';
import express from 'express';
import { KvBlockDeviceExpressRouter } from '../lib/http/kvbd-express-router';
import { mkdirSync } from 'fs';

const BLOCK_SIZE = 4096;
const PORT = 3000;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const serverEncryption = new KvEncryptionNone();

    const serverBlockDevice = new KvBlockDeviceFs(
        BLOCK_SIZE,
        LOCAL_FS_PATH,
        serverEncryption,
    );
    await serverBlockDevice.init();

    const server = express();
    const router = express.Router();
    const bdRouter = new KvBlockDeviceExpressRouter();
    server.use(express.json());
    bdRouter.route(serverBlockDevice, router);
    server.use(router);

    return new Promise<void>((resolve) => {
        server.listen(PORT, () => {
            console.log(`Server is listening on :${PORT}`);
            resolve();
        });
    });
}

run().catch(console.error);
