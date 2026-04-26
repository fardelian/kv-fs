import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvBlockDeviceSqlite3 } from '../lib/block-devices';
import { mkdirSync } from 'fs';
import { AsyncDatabase } from 'promised-sqlite3';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 5;

const LOCAL_FS_PATH = `${import.meta.dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    console.log(`[1/${STEP_COUNT}] opening SQLite database...`);
    const database = await AsyncDatabase.open(`${LOCAL_FS_PATH}/data.sqlite3`);

    const sqliteBlockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        database,
        'blocks_permanent',
    );

    const highestBlockIdBefore = await sqliteBlockDevice.getHighestBlockId();
    if (highestBlockIdBefore > -1) {
        console.log(`[2/${STEP_COUNT}] file system exists (highestBlockId=${highestBlockIdBefore}); reusing.`);
    } else {
        console.log(`[2/${STEP_COUNT}] file system does not exist; formatting.`);
        await KvFilesystem.format(sqliteBlockDevice, TOTAL_NODES);
    }

    const fileSystem = new KvFilesystem(sqliteBlockDevice, SUPER_BLOCK_ID);
    const easyFileSystem = new KvFilesystemSimple(fileSystem, '/');

    console.log(`[3/${STEP_COUNT}] creating test files under /home/florin/...`);
    await easyFileSystem.createDirectory('/home/florin', true);

    const testPath1 = '/home/florin/test1.txt';
    const testFile1 = await easyFileSystem.createFile(testPath1);
    await testFile1.write(new TextEncoder().encode('hello world'));

    const testPath2 = '/home/florin/test2.txt';
    const testFile2 = await easyFileSystem.createFile(testPath2);
    await testFile2.write(new TextEncoder().encode('and hello again'));

    console.log(`[4/${STEP_COUNT}] reading test files back...`);
    const testRead1 = await easyFileSystem.readFile(testPath1);
    const testRead2 = await easyFileSystem.readFile(testPath2);
    const testDir = await easyFileSystem.getDirectory('/home/florin');

    const decoder = new TextDecoder();
    console.log('  testRead1:', decoder.decode(testRead1));
    console.log('  testRead2:', decoder.decode(testRead2));
    console.log('  testDir:', await testDir.read());

    console.log(`[5/${STEP_COUNT}] walking the directory tree:`);
    const homeDir = await easyFileSystem.getDirectory('/home');
    console.log('  homeDir:', await homeDir.read());

    const rootDir = await easyFileSystem.getDirectory('/');
    console.log('  rootDir:', await rootDir.read());

    const highestBlockIdAfter = await sqliteBlockDevice.getHighestBlockId();
    console.log(`  highestBlockId after: ${highestBlockIdAfter}`);
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
