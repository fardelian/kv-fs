import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvBlockDeviceHttpClient, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionPassword } from '../lib/encryption';

const PORT = 3000;

const ENC_PASSWORD = 'the_user_password';
const ENC_SALT = 'some_static_secret';
const ENC_ITERATIONS = 10;

const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

async function run() {
    // Pure transport — fetches blockSize/capacityBytes from the server.
    const httpClient = new KvBlockDeviceHttpClient(`http://localhost:${PORT}`);

    // Peek at what the server advertises before init() does the same fetch.
    const metaBefore = await fetch(`http://localhost:${PORT}/blocks`);
    console.log('GET /blocks:', await metaBefore.json());

    await httpClient.init();

    // Wrap with encryption. The exposed block size shrinks by the cipher's
    // overhead; the wire still carries blocks of the server's size.
    const clientEncryption = new KvEncryptionPassword(ENC_PASSWORD, ENC_SALT, ENC_ITERATIONS);
    const clientBlockDevice = new KvEncryptedBlockDevice(httpClient, clientEncryption);

    // Format and mount.
    await KvFilesystem.format(clientBlockDevice, TOTAL_INODES);

    const fileSystem = new KvFilesystem(clientBlockDevice, SUPER_BLOCK_ID);
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

    // Peek at what the server advertises after the demo has finished.
    const metaAfter = await fetch(`http://localhost:${PORT}/blocks`);
    console.log('GET /blocks:', await metaAfter.json());
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
