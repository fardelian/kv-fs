import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';
import { KvEncryptionPassword } from '../lib/encryption';
import { KvBlockDeviceHttpClient } from '../lib/block-devices';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const PORT = 3000;

const ENC_PASSWORD = 'the_user_password';
const ENC_SALT = 'some_static_secret';
const ENC_ITERATIONS = 10;

async function run() {
    // Create encrypted client

    const clientEncryption = new KvEncryptionPassword(ENC_PASSWORD, ENC_SALT, ENC_ITERATIONS);

    const clientBlockDevice = new KvBlockDeviceHttpClient(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        `http://localhost:${PORT}`,
        clientEncryption,
    );

    // Create file system

    await KvFilesystem.format(clientBlockDevice, TOTAL_BLOCKS, TOTAL_NODES);

    const fileSystem = new KvFilesystem(clientBlockDevice, SUPER_BLOCK_ID);
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
}

run().catch(console.error);

/*

    Expected output:

    testRead1: hello world
    testRead2: and hello again
    testDir: Map(2) { 'test1.txt' => 4, 'test2.txt' => 6 }
    homeDir: Map(1) { 'florin' => 3 }
    rootDir: Map(1) { 'home' => 2 }

*/
