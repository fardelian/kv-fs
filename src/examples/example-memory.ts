import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';
import { KvBlockDeviceMemory, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionNone } from '../lib/encryption';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

async function run() {
    const t0 = new Date().getTime();

    // Create block device

    const encryption = new KvEncryptionNone();

    const memoryBlockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);

    const encryptedMemoryBlockDevice = new KvEncryptedBlockDevice(memoryBlockDevice, encryption);

    // Create file system

    await KvFilesystem.format(encryptedMemoryBlockDevice, TOTAL_BLOCKS, TOTAL_NODES);

    const fileSystem = new KvFilesystem(encryptedMemoryBlockDevice, SUPER_BLOCK_ID);
    const easyFileSystem = new KvFilesystemEasy(fileSystem, '/');

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

    console.log('time:', new Date().getTime() - t0);
}

run().catch(console.error);
