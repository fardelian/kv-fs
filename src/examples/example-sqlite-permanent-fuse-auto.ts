/**
 * Example: persist a kv-fs into a SQLite table and surface its
 * contents through the FUSE adapter.
 *
 * The flow:
 *   1. Open the persistent SQLite database (same one as
 *      example-sqlite-permanent.ts) but mount a *different* table —
 *      `blocks_fuse_demo` — so the two examples don't share state.
 *   2. Detect whether the kv-fs has been formatted yet (by looking at
 *      the device's highest block ID); format it on the first run.
 *   3. Wrap the simple kv-fs in `KvFuseHandlers` — that's the in-tree
 *      FUSE-shaped adapter; `getattr` / `readdir` / `read` / `write`
 *      use the same callback shapes a real fuse-native binding would
 *      invoke. To actually mount this volume on a host filesystem,
 *      see example-fuse-mount.ts and `npm install fuse-native`.
 *   4. Write a fresh file with random bytes via `KvFilesystemSimple`.
 *   5. List the kv-fs root through the FUSE handlers — the same
 *      `(name, size, ctime)` tuples a real `fs.readdirSync` /
 *      `fs.statSync` against a mounted FUSE volume would produce.
 *   6. Use Node's built-in `fs/promises` (the one bundled with bun) to
 *      read what the *host* sees — a single `data.sqlite3` file
 *      holding every kv-fs block. Side-by-side with the FUSE listing
 *      this makes the abstraction concrete: many "files" inside one
 *      backing file outside.
 */
import { stat } from 'fs/promises';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { AsyncDatabase } from 'promised-sqlite3';
import { KvBlockDeviceSqlite3 } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvFuseHandlers } from '../lib/fuse';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

const TABLE_NAME = 'blocks_fuse_demo';
const LOCAL_FS_PATH = `${__dirname}/../../data`;
const DB_PATH = `${LOCAL_FS_PATH}/data.sqlite3`;

mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run(): Promise<void> {
    const database = await AsyncDatabase.open(DB_PATH);
    try {
        // ---- 1. Mount the kv-fs on top of a fresh SQLite table ----
        const blockDevice = new KvBlockDeviceSqlite3(
            BLOCK_SIZE,
            BLOCK_SIZE * TOTAL_BLOCKS,
            database,
            TABLE_NAME,
        );

        // ---- 2. Format if missing — `getHighestBlockId() === -1` is the
        //         canonical "fresh device" signal across every backend. ----
        const highestBefore = await blockDevice.getHighestBlockId();
        if (highestBefore === -1) {
            console.log(`Table "${TABLE_NAME}" is empty — formatting a fresh kv-fs volume.`);
            await KvFilesystem.format(blockDevice, TOTAL_INODES);
        } else {
            console.log(`Table "${TABLE_NAME}" already populated (highest block id = ${highestBefore}); reusing the existing kv-fs volume.`);
        }

        // ---- 3. Build the kv-fs and the FUSE adapter that surfaces it ----
        const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const easyFs = new KvFilesystemSimple(filesystem, '/');
        const handlers = new KvFuseHandlers(easyFs, BLOCK_SIZE);

        // ---- 4. Write a file with random bytes via the kv-fs API ----
        // A timestamped name lets re-runs accumulate so the listing in
        // step 5 grows visibly with each invocation.
        const fileName = `random-${Date.now()}.bin`;
        const filePath = `/${fileName}`;
        const payload = new Uint8Array(randomBytes(2048));
        const file = await easyFs.createFile(filePath);
        await file.write(payload);
        console.log(`\nWrote ${payload.length} random bytes → ${filePath}`);

        // ---- 5. List the kv-fs root via the FUSE adapter ----
        // Same call shape (`readdir` + `getattr`) that a real fuse-native
        // mount would dispatch when you run `fs.readdir` / `fs.stat`
        // against the mount point.
        console.log('\nKv-fs / contents (via FUSE readdir + getattr):');
        const names = await handlers.readdir('/');
        const fmtRow = (name: string, size: number, ctime: Date) =>
            `  ${name.padEnd(40)}  size=${String(size).padStart(8)}  ctime=${ctime.toISOString()}`;
        for (const name of names) {
            const attr = await handlers.getattr(`/${name}`);
            console.log(fmtRow(name, attr.size, attr.ctime));
        }

        // ---- 6. What the host sees: one backing SQLite file ----
        // Node's `fs/promises` ships with bun; this is the "built-in
        // bun fs module" view of the same volume — except the host
        // sees the entire kv-fs as a single `.sqlite3` file because
        // FUSE isn't actually mounted at the OS level here. The
        // contrast is the point: the `easyFs.createFile` call above
        // wrote a file inside the kv-fs, but on disk it's just a few
        // more rows in one SQLite database file.
        console.log('\nHost view (via bun fs/promises):');
        const dbStat = await stat(DB_PATH);
        console.log(fmtRow(DB_PATH.replace(`${LOCAL_FS_PATH}/`, ''), dbStat.size, dbStat.birthtime));
    } finally {
        await database.close();
    }
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
