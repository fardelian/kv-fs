import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvBlockDeviceSqlite3, wrapBunSqliteDatabase } from '../lib/block-devices';
import { mkdirSync } from 'fs';
import { Database } from 'bun:sqlite';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    // Create encrypted block device

    const database = new Database(`${LOCAL_FS_PATH}/data.sqlite3`);
    const driver = wrapBunSqliteDatabase(database);

    const sqliteBlockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        driver,
        'blocks_permanent',
    );

    // Create file system if it doesn't exist

    const highestBlockIdBefore = await sqliteBlockDevice.getHighestBlockId();
    console.log('highestBlockId', highestBlockIdBefore);

    const fsExists = highestBlockIdBefore > -1;
    if (fsExists) {
        console.log('File system exists.');
    } else {
        console.log('File system does not exist. Formatting.');
        await KvFilesystem.format(sqliteBlockDevice, TOTAL_NODES);
    }

    const fileSystem = new KvFilesystem(sqliteBlockDevice, SUPER_BLOCK_ID);
    const easyFileSystem = new KvFilesystemSimple(fileSystem, '/');

    // Create test files

    await easyFileSystem.createDirectory('/home/florin', true);

    const testPath1 = '/home/florin/test1.txt';
    const testFile1 = await easyFileSystem.createFile(testPath1);
    await testFile1.write(new TextEncoder().encode('hello world'));

    const testPath2 = '/home/florin/test2.txt';
    const testFile2 = await easyFileSystem.createFile(testPath2);
    await testFile2.write(new TextEncoder().encode('and hello again'));

    // Read test files

    const testRead1 = await easyFileSystem.readFile(testPath1);
    const testRead2 = await easyFileSystem.readFile(testPath2);
    const testDir = await easyFileSystem.getDirectory('/home/florin');

    const decoder = new TextDecoder();
    console.log('testRead1:', decoder.decode(testRead1));
    console.log('testRead2:', decoder.decode(testRead2));
    console.log('testDir:', await testDir.read());

    const homeDir = await easyFileSystem.getDirectory('/home');
    console.log('homeDir:', await homeDir.read());

    const rootDir = await easyFileSystem.getDirectory('/');
    console.log('rootDir:', await rootDir.read());

    const highestBlockIdAfter = await sqliteBlockDevice.getHighestBlockId();
    console.log('highestBlockId', highestBlockIdAfter);
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
