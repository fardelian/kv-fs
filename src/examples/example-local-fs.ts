import { KvFilesystem } from '../lib/filesystem/kv-filesystem';
import { KvFilesystemEasy } from '../lib/filesystem/kv-filesystem-easy';
import { KvBlockDeviceFs } from '../lib/block-device/kv-block-device-fs';
import { KvEncryptionNone } from '../lib/encryption/kv-encryption-none';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

async function run() {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const t0 = new Date().getTime();

    // const password = FileSystemEncryption.keyFromPassword(
    //     'password',
    //     'salt',
    //     100000,
    // );
    const encryption = new KvEncryptionNone();

    const blockDevice = new KvBlockDeviceFs(
        `${__dirname}/../../data`,
        BLOCK_SIZE,
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

    const testWrite1 = '/home/florin/test1.txt';
    const testFile1 = await easyFileSystem.createFile(testWrite1);
    await testFile1.write(Buffer.from('hello world'));

    const testWrite2 = '/home/florin/test2.txt';
    const testFile2 = await easyFileSystem.createFile(testWrite2);
    await testFile2.write(Buffer.from('and hello again'));

    // Read test files

    const testRead1 = await easyFileSystem.readFile('/home/florin/test1.txt');
    const testRead2 = await easyFileSystem.readFile('/home/florin/test2.txt');
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
