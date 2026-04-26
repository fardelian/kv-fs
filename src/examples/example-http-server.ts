import {
    KvBlockDeviceHttpRouter,
    KvEncryptedBlockDevice,
    KvBlockDeviceSqlite3,
} from '../lib/block-devices';
import { KvEncryptionRot13 } from '../lib/encryption';
import express from 'express';
import { mkdirSync } from 'fs';
import { AsyncDatabase } from 'promised-sqlite3';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const PORT = 3000;

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 4;

const LOCAL_FS_PATH = `${import.meta.dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const t0 = new Date().getTime();

    console.log(`[1/${STEP_COUNT}] opening SQLite database...`);
    const database = await AsyncDatabase.open(`${LOCAL_FS_PATH}/data.sqlite3`);

    console.log(`[2/${STEP_COUNT}] building backend block device (sqlite + rot13 encryption)...`);
    const encryption = new KvEncryptionRot13();
    const sqliteBlockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        database,
        'blocks',
    );
    const encryptedServerBlockDevice = new KvEncryptedBlockDevice(sqliteBlockDevice, encryption);

    console.log(`[3/${STEP_COUNT}] mounting KvBlockDeviceHttpRouter on an Express router...`);
    const router = express.Router();
    const bdRouter = new KvBlockDeviceHttpRouter(encryptedServerBlockDevice);
    bdRouter.mount(router);

    // Block bodies arrive as raw bytes — `express.raw()` captures them
    // as a Buffer on `req.body`. JSON parsing stays for any future
    // endpoints that exchange structured data.
    const server = express();
    server.use(express.raw({
        type: 'application/octet-stream',
        // One block plus comfortable headroom for the AEAD overhead so
        // wrapped writes still fit. Bump if you swap to a much larger
        // block size or a heavier overhead cipher.
        limit: BLOCK_SIZE * 2,
    }));
    server.use(express.json());
    server.use(router);

    console.log(`[4/${STEP_COUNT}] starting Express server on :${PORT}...`);
    await new Promise<void>((resolve) => {
        server.listen(PORT, () => {
            console.log(`      listening on http://localhost:${PORT}`);
            resolve();
        });
    });

    console.log('device:', {
        blockSize: encryptedServerBlockDevice.getBlockSize(),
        capacityBytes: encryptedServerBlockDevice.getCapacityBytes(),
        capacityBlocks: encryptedServerBlockDevice.getCapacityBlocks(),
        highestBlockId: await encryptedServerBlockDevice.getHighestBlockId(),
    });
    console.log(`time-to-listen: ${new Date().getTime() - t0}`);

    // The server runs forever; trap SIGINT so the standard `time:` line
    // still gets a chance to fire on Ctrl+C, then close the DB and exit.
    process.on('SIGINT', () => {
        console.log(`\ntime: ${new Date().getTime() - t0}`);
        void database.close().finally(() => process.exit(0));
    });
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
