import { KvFilesystem } from '../lib/filesystem/kv-filesystem';
import { KvFilesystemEasy } from '../lib/filesystem/kv-filesystem-easy';
import { KvEncryptionNone } from '../lib/encryption/kv-encryption-none';
import { KvBlockDeviceHttpClient } from '../lib/block-device/kv-block-device-http-client';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const PORT = 3000;

async function run() {
    // Create client

    const clientEncryption = new KvEncryptionNone();

    const clientBlockDevice = new KvBlockDeviceHttpClient(
        `http://localhost:${PORT}`,
        BLOCK_SIZE,
        clientEncryption,
    );

    // Create file system

    await KvFilesystem.format(clientBlockDevice, TOTAL_BLOCKS, TOTAL_NODES);

    const fileSystem = new KvFilesystem(clientBlockDevice, SUPER_BLOCK_ID);
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
}

run().catch(console.error);
