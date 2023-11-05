import { KvBlockDeviceFs } from '../lib/block-device/kv-block-device-fs';
import { KvEncryptionNone } from '../lib/encryption/kv-encryption-none';
import express from 'express';
import { KvBlockDeviceExpressRouter } from '../lib/http/kvbd-express-router';

const BLOCK_SIZE = 4096;
const PORT = 3000;

async function run() {
    const serverEncryption = new KvEncryptionNone();

    const serverBlockDevice = new KvBlockDeviceFs(
        `${__dirname}/../../data`,
        BLOCK_SIZE,
        serverEncryption,
    );
    await serverBlockDevice.init();

    return new Promise<void>((resolve) => {
        const server = express();
        const router = express.Router();
        const bdRouter = new KvBlockDeviceExpressRouter();
        server.use(express.json());
        bdRouter.route(serverBlockDevice, router);
        server.use(router);
        server.listen(PORT, () => {
            console.log(`Server is listening on :${PORT}`);
            resolve();
        });
    });
}

run().catch(console.error);
