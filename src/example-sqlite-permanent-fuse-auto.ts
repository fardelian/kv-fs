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
 *      see example-sqlite-permanent-fuse-manual.ts.
 *   4. Drop a per-run timestamp file at /YYYY-MM-DD/HH-MM-SS.txt so
 *      re-runs accumulate visible state inside the kv-fs.
 *   5. List the kv-fs root through the FUSE handlers — the same
 *      `(name, size, ctime)` tuples a real `fs.readdirSync` /
 *      `fs.statSync` against a mounted FUSE volume would produce.
 *      Recurses one level into date directories so the timestamp
 *      files show up in the listing.
 *   6. Use Node's built-in `fs/promises` to read what the *host* sees
 *      — a single `data.sqlite3` file holding every kv-fs block.
 *      Side-by-side with the FUSE listing this makes the abstraction
 *      concrete: many "files" inside one backing file outside.
 */
import { stat } from 'fs/promises';
import { mkdirSync } from 'fs';
import { AsyncDatabase } from 'promised-sqlite3';
import { KvBlockDeviceSqlite3 } from 'kv-fs-lib';
import { KvFilesystem, KvFilesystemSimple } from 'kv-fs-lib';
import { KvFuseHandlers } from 'kv-fs-lib';
import { KvError_FS_Exists } from 'kv-fs-lib';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 6;

const TABLE_NAME = 'blocks_fuse_demo';
const LOCAL_FS_PATH = `${import.meta.dirname}/../data`;
const DB_PATH = `${LOCAL_FS_PATH}/data.sqlite3`;

mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run(): Promise<void> {
    const t0 = new Date().getTime();

    console.log(`[1/${STEP_COUNT}] opening SQLite database...`);
    const database = await AsyncDatabase.open(DB_PATH);
    try {
        const blockDevice = new KvBlockDeviceSqlite3(
            BLOCK_SIZE,
            BLOCK_SIZE * TOTAL_BLOCKS,
            database,
            TABLE_NAME,
        );

        // Same gate as example-sqlite-permanent: a freshly-formatted
        // volume leaves the superblock + root directory blocks
        // (highest >= 1), so `< 2` covers both "no blocks at all" and
        // "stale partial init".
        const highestBefore = await blockDevice.getHighestBlockId();
        const needsFormat = highestBefore < 2;
        if (needsFormat) {
            console.log(`[2/${STEP_COUNT}] table "${TABLE_NAME}" is empty — formatting a fresh kv-fs volume.`);
            await KvFilesystem.format(blockDevice, TOTAL_INODES);
        } else {
            console.log(`[2/${STEP_COUNT}] table "${TABLE_NAME}" already populated (highest block id = ${highestBefore}); reusing the existing kv-fs volume.`);
        }

        console.log(`[3/${STEP_COUNT}] building KvFilesystem + KvFuseHandlers adapter...`);
        const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const easyFs = new KvFilesystemSimple(filesystem, '/');
        const handlers = new KvFuseHandlers(easyFs, BLOCK_SIZE);

        // Per-run timestamp drop: /YYYY-MM-DD/HH-MM-SS.txt with the full
        // ISO string as content. Same pattern as example-sqlite-permanent.
        const isoNow = new Date().toISOString();
        const dayDir = `/${isoNow.slice(0, 10)}`;
        const timePath = `${dayDir}/${isoNow.slice(11, 19).replace(/:/g, '-')}.txt`;
        console.log(`[4/${STEP_COUNT}] writing run timestamp to ${timePath}...`);
        try {
            await easyFs.createDirectory(dayDir);
        } catch (err) {
            if (!(err instanceof KvError_FS_Exists)) throw err;
        }
        const timeFile = await easyFs.createFile(timePath);
        await timeFile.write(new TextEncoder().encode(isoNow));
        console.log(`  wrote ${timePath} = "${isoNow}"`);

        // Same call shape (`readdir` + `getattr`) that a real fuse-native
        // mount would dispatch when you run `fs.readdir` / `fs.stat`
        // against the mount point. Recurses one level into date dirs
        // so the timestamp files are visible.
        console.log(`[5/${STEP_COUNT}] kv-fs / contents (via FUSE readdir + getattr):`);
        const fmtRow = (name: string, size: number, ctime: Date): string =>
            `  ${name.padEnd(40)}  size=${String(size).padStart(8)}  ctime=${ctime.toISOString()}`;
        const names = await handlers.readdir('/');
        for (const name of names) {
            const attr = await handlers.getattr(`/${name}`);
            console.log(fmtRow(name, attr.size, attr.ctime));
            if (/^\d{4}-\d{2}-\d{2}$/.test(name)) {
                const children = await handlers.readdir(`/${name}`);
                for (const child of children) {
                    const childAttr = await handlers.getattr(`/${name}/${child}`);
                    console.log(fmtRow(`  ${name}/${child}`, childAttr.size, childAttr.ctime));
                }
            }
        }

        // Node's `fs/promises` view of the same volume — except the
        // host sees the entire kv-fs as a single `.sqlite3` file
        // because FUSE isn't actually mounted at the OS level here.
        // The contrast is the point: every kv-fs file we just listed
        // is just more rows in one SQLite database file on disk.
        console.log(`[6/${STEP_COUNT}] host view (via Node fs/promises):`);
        const dbStat = await stat(DB_PATH);
        console.log(fmtRow(DB_PATH.replace(`${LOCAL_FS_PATH}/`, ''), dbStat.size, dbStat.birthtime));

        console.log('device:', {
            blockSize: blockDevice.getBlockSize(),
            capacityBytes: blockDevice.getCapacityBytes(),
            capacityBlocks: blockDevice.getCapacityBlocks(),
            highestBlockId: await blockDevice.getHighestBlockId(),
        });
    } finally {
        await database.close();
    }

    console.log('time:', new Date().getTime() - t0);
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
