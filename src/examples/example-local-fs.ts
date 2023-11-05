import { KvFilesystem } from '../lib/filesystem/kv-filesystem';
import { KvFilesystemEasy } from '../lib/filesystem/kv-filesystem-easy';
import { KvBlockDeviceFs } from '../lib/block-device/kv-block-device-fs';
import { KvEncryptionNone } from '../lib/encryption/kv-encryption-none';
import { mkdir, mkdirSync } from 'fs';
import { KvEncryptionPassword } from '../lib/encryption/kv-encryption-password';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const t0 = new Date().getTime();

    const encryption = new KvEncryptionNone();

    const blockDevice = new KvBlockDeviceFs(
        BLOCK_SIZE,
        LOCAL_FS_PATH,
        encryption,
    );
    await blockDevice.init();

    // Create file system

    await KvFilesystem.format(blockDevice, TOTAL_BLOCKS, TOTAL_NODES);

    const fileSystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
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
