import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvBlockDeviceFs, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionRot13 } from '../lib/encryption';
import { KvError_FS_Exists } from '../lib/utils';
import { mkdirSync } from 'fs';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_NODES = 100;

const SUPER_BLOCK_ID = 0;

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 7;

// Dedicated subdir so the per-block files (`{id}.txt`) don't get mixed
// up with the sqlite examples' `data.sqlite3`.
const LOCAL_FS_PATH = `${import.meta.dirname}/../../data/local-fs-permanent`;
mkdirSync(LOCAL_FS_PATH, { recursive: true });

async function run() {
    const t0 = new Date().getTime();

    console.log(`[1/${STEP_COUNT}] building local-fs block device wrapped with rot13 encryption...`);
    const encryption = new KvEncryptionRot13();
    const fsBlockDevice = new KvBlockDeviceFs(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        LOCAL_FS_PATH,
    );
    const encryptedFsBlockDevice = new KvEncryptedBlockDevice(fsBlockDevice, encryption);

    // Same gate as example-sqlite-permanent: a freshly-formatted volume
    // leaves the superblock + root directory blocks (highest >= 1), so
    // `< 2` covers both "no blocks at all" and "stale partial init".
    const highestBlockIdBefore = await encryptedFsBlockDevice.getHighestBlockId();
    const needsFormat = highestBlockIdBefore < 2;
    if (needsFormat) {
        console.log(`[2/${STEP_COUNT}] file system does not exist; formatting.`);
        await KvFilesystem.format(encryptedFsBlockDevice, TOTAL_NODES);
    } else {
        console.log(`[2/${STEP_COUNT}] file system exists (highestBlockId=${highestBlockIdBefore}); reusing.`);
    }

    const fileSystem = new KvFilesystem(encryptedFsBlockDevice, SUPER_BLOCK_ID);
    const easyFileSystem = new KvFilesystemSimple(fileSystem, '/');

    const testPath1 = '/home/florin/test1.txt';
    const testPath2 = '/home/florin/test2.txt';

    if (needsFormat) {
        console.log(`[3/${STEP_COUNT}] seeding test files under /home/florin/...`);
        await easyFileSystem.createDirectory('/home/florin', true);

        const testFile1 = await easyFileSystem.createFile(testPath1);
        await testFile1.write(new TextEncoder().encode('hello world'));

        const testFile2 = await easyFileSystem.createFile(testPath2);
        await testFile2.write(new TextEncoder().encode('and hello again'));
    } else {
        console.log(`[3/${STEP_COUNT}] reusing existing test files (skipping seed).`);
    }

    console.log(`[4/${STEP_COUNT}] reading test files back...`);
    const testRead1 = await easyFileSystem.readFile(testPath1);
    const testRead2 = await easyFileSystem.readFile(testPath2);
    const testDir = await easyFileSystem.getDirectory('/home/florin');

    const decoder = new TextDecoder();
    console.log('  testRead1:', decoder.decode(testRead1));
    console.log('  testRead2:', decoder.decode(testRead2));
    console.log('  testDir:', await testDir.read());

    console.log(`[5/${STEP_COUNT}] walking the directory tree:`);
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

    // List every previous run's timestamp drop.
    console.log(`[7/${STEP_COUNT}] listing all run timestamps:`);
    const rootEntries = await (await easyFileSystem.getDirectory('/')).read();
    const dayDirs = [...rootEntries.keys()]
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort();
    for (const day of dayDirs) {
        const dayEntries = await (await easyFileSystem.getDirectory(`/${day}`)).read();
        const files = [...dayEntries.keys()].sort();
        console.log(`  /${day}/  (${files.length} ${files.length === 1 ? 'entry' : 'entries'})`);
        for (const f of files) {
            const content = decoder.decode(await easyFileSystem.readFile(`/${day}/${f}`));
            console.log(`    /${day}/${f} = "${content}"`);
        }
    }

    console.log('device:', {
        blockSize: encryptedFsBlockDevice.getBlockSize(),
        capacityBytes: encryptedFsBlockDevice.getCapacityBytes(),
        capacityBlocks: encryptedFsBlockDevice.getCapacityBlocks(),
        highestBlockId: await encryptedFsBlockDevice.getHighestBlockId(),
    });

    console.log('time:', new Date().getTime() - t0);
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
