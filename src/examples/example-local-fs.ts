import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvBlockDeviceFs } from '../lib/block-devices';
import { KvEncryptionRot13 } from '../lib/encryption';
import { mkdirSync } from 'fs';
import { KvEncryptedBlockDevice } from '../lib/block-devices';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

const LOCAL_FS_PATH = `${__dirname}/../../data`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const t0 = new Date().getTime();

    // Create encrypted block device

    const encryption = new KvEncryptionRot13();

    const fsBlockDevice = new KvBlockDeviceFs(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        LOCAL_FS_PATH,
    );

    const encryptedFsBlockDevice = new KvEncryptedBlockDevice(fsBlockDevice, encryption);

    // Create file system

    await KvFilesystem.format(encryptedFsBlockDevice, TOTAL_NODES);

    const fileSystem = new KvFilesystem(encryptedFsBlockDevice, SUPER_BLOCK_ID);
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

    // Demonstrate byte-addressable partial reads/writes (POSIX-style
    // pread/pwrite). They don't move the file's read/write position
    // and they go through the block device's native partial path —
    // for the FS backend this is positioned `fd.read` / `fd.write`,
    // so only the requested bytes touch disk.
    const partialPath = '/home/florin/partial.bin';
    const partialFile = await easyFileSystem.createFile(partialPath);
    await partialFile.write(new TextEncoder().encode('Hello, partial world!'));

    // Splice "PATCH" in at offset 7, replacing "partial" → "PATCHal " region.
    await partialFile.writePartial(7, new TextEncoder().encode('PATCH'));

    // Read just the patched window without moving the cursor.
    const patched = await partialFile.readPartial(7, 5);
    console.log('readPartial(7, 5):', decoder.decode(patched));

    await partialFile.setPos(0);
    const wholeAfter = await partialFile.read();
    console.log('full file after writePartial:', decoder.decode(wholeAfter));

    console.log('time:', new Date().getTime() - t0);
}

run().catch(console.error);
