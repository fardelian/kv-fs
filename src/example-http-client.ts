import { KvFilesystem, KvFilesystemSimple } from 'kv-fs-lib';
import { KvBlockDeviceHttpClient, KvEncryptedBlockDevice } from 'kv-fs-lib';
import { KvEncryptionPassword } from 'kv-fs-lib';
import { KvError_FS_Exists } from 'kv-fs-lib';

const PORT = 3003;

const ENC_PASSWORD = 'the_user_password';
const ENC_SALT = 'some_static_secret';
const ENC_ITERATIONS = 10;

const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 7;

async function run() {
    const t0 = new Date().getTime();

    console.log(`[1/${STEP_COUNT}] connecting to remote block device at http://localhost:${PORT}...`);
    const httpClient = new KvBlockDeviceHttpClient(`http://localhost:${PORT}`);

    // Peek at what the server advertises before init() does the same fetch.
    const metaBefore = await fetch(`http://localhost:${PORT}/blocks`);
    console.log('  GET /blocks:', await metaBefore.json());

    await httpClient.init();

    console.log(`[2/${STEP_COUNT}] wrapping the transport with password-based encryption...`);
    // The exposed block size shrinks by the cipher's overhead; the wire
    // still carries blocks of the server's size.
    const clientEncryption = new KvEncryptionPassword(ENC_PASSWORD, ENC_SALT, ENC_ITERATIONS);
    const clientBlockDevice = new KvEncryptedBlockDevice(httpClient, clientEncryption);

    console.log(`[3/${STEP_COUNT}] formatting a fresh kv-fs volume on the remote device...`);
    await KvFilesystem.format(clientBlockDevice, TOTAL_INODES);

    const fileSystem = new KvFilesystem(clientBlockDevice, SUPER_BLOCK_ID);
    const easyFileSystem = new KvFilesystemSimple(fileSystem, '/');

    console.log(`[4/${STEP_COUNT}] creating test files under /home/florin/...`);
    await easyFileSystem.createDirectory('/home/florin', true);

    const testPath1 = '/home/florin/test1.txt';
    const testFile1 = await easyFileSystem.createFile(testPath1);
    await testFile1.write(new TextEncoder().encode('hello world'));

    const testPath2 = '/home/florin/test2.txt';
    const testFile2 = await easyFileSystem.createFile(testPath2);
    await testFile2.write(new TextEncoder().encode('and hello again'));

    console.log(`[5/${STEP_COUNT}] reading test files back + walking the directory tree...`);
    const testRead1 = await easyFileSystem.readFile(testPath1);
    const testRead2 = await easyFileSystem.readFile(testPath2);
    const testDir = await easyFileSystem.getDirectory('/home/florin');

    const decoder = new TextDecoder();
    console.log('  testRead1:', decoder.decode(testRead1));
    console.log('  testRead2:', decoder.decode(testRead2));
    console.log('  testDir:', await testDir.read());

    const homeDir = await easyFileSystem.getDirectory('/home');
    console.log('  homeDir:', await homeDir.read());

    const rootDir = await easyFileSystem.getDirectory('/');
    console.log('  rootDir:', await rootDir.read());

    // Per-run timestamp drop: /YYYY-MM-DD/HH-MM-SS.txt with the full ISO
    // string as content. Same pattern as example-sqlite-permanent.
    const isoNow = new Date().toISOString();
    const dayDir = `/${isoNow.slice(0, 10)}`;
    const timePath = `${dayDir}/${isoNow.slice(11, 19).replace(/:/g, '-')}.txt`;
    console.log(`[6/${STEP_COUNT}] writing run timestamp to ${timePath}...`);
    try {
        await easyFileSystem.createDirectory(dayDir);
    } catch (err) {
        if (!(err instanceof KvError_FS_Exists)) throw err;
    }
    const timeFile = await easyFileSystem.createFile(timePath);
    await timeFile.write(new TextEncoder().encode(isoNow));
    console.log(`  wrote ${timePath} = "${isoNow}"`);

    console.log(`[7/${STEP_COUNT}] re-fetching server metadata to confirm allocations:`);
    const metaAfter = await fetch(`http://localhost:${PORT}/blocks`);
    console.log('  GET /blocks:', await metaAfter.json());

    console.log('time:', new Date().getTime() - t0);
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
