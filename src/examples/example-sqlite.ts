import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';
import { KvBlockDeviceFs, KvBlockDeviceSqlite3 } from '../lib/block-devices';
import { KvEncryptionNone } from '../lib/encryption';
import { mkdirSync } from 'fs';
import { KvEncryptedBlockDevice } from '../lib/block-devices';
import { Database } from 'sqlite3';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const t0 = new Date().getTime();

    // Create block device

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

    const encryptedFsBlockDevice = new KvEncryptedBlockDevice(sqliteBlockDevice, encryption);
    await encryptedFsBlockDevice.init();

    // Create file system

    await KvFilesystem.format(encryptedFsBlockDevice, TOTAL_BLOCKS, TOTAL_NODES);

    const fileSystem = new KvFilesystem(encryptedFsBlockDevice, SUPER_BLOCK_ID);
    await fileSystem.init();
    const easyFileSystem = new KvFilesystemEasy(fileSystem, '/');
    await easyFileSystem.init();

    // Create test files

    await easyFileSystem.createDirectory('/home/florin', true);

    const testPath1 = '/home/florin/test1.txt';
    const testFile1 = await easyFileSystem.createFile(testPath1);
    await testFile1.write(Buffer.from('hello world'));

    const testPath2 = '/home/florin/test2.txt';
    const testFile2 = await easyFileSystem.createFile(testPath2);
    await testFile2.write(Buffer.from('and hello again'));

    // Read test files

    const testRead1 = await easyFileSystem.readFile(testPath1);
    const testRead2 = await easyFileSystem.readFile(testPath2);
    const testDir = await easyFileSystem.getDirectory('/home/florin');

    console.log('testRead1:', testRead1.toString());
    console.log('testRead2:', testRead2.toString());
    console.log('testDir:', await testDir.read());

    const homeDir = await easyFileSystem.getDirectory('/home');
    console.log('homeDir:', await homeDir.read());

    const rootDir = await easyFileSystem.getDirectory('/');
    console.log('rootDir:', await rootDir.read());

    console.log('time:', new Date().getTime() - t0);
}

run().catch(console.error);
