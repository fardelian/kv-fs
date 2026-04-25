import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

async function makeFs(): Promise<KvFilesystemEasy> {
    const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(blockDevice, TOTAL_INODES);
    const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
    return new KvFilesystemEasy(filesystem, '/');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('kv-fs (acceptance)', () => {
    it('round-trips files through nested directories', async () => {
        const fs = await makeFs();

        const content1 = faker.lorem.sentence();
        const content2 = faker.lorem.sentence();

        await fs.createDirectory('/home/florin', true);

        const file1 = await fs.createFile('/home/florin/test1.txt');
        await file1.write(encoder.encode(content1));

        const file2 = await fs.createFile('/home/florin/test2.txt');
        await file2.write(encoder.encode(content2));

        expect(decoder.decode(await fs.readFile('/home/florin/test1.txt'))).toBe(content1);
        expect(decoder.decode(await fs.readFile('/home/florin/test2.txt'))).toBe(content2);
    });

    it('lists directories at every level of the path', async () => {
        const fs = await makeFs();

        await fs.createDirectory('/home/florin', true);
        await fs.createDirectory('/home/cat', true);
        await fs.createFile('/home/florin/note.txt');

        const root = await fs.readDirectory('/');
        const home = await fs.readDirectory('/home');
        const florin = await fs.readDirectory('/home/florin');

        expect(root).toContain('home');
        expect(home).toEqual(['florin', 'cat']);
        expect(florin).toContain('note.txt');
    });

    it('rewinds with setPos and writes over existing content', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/data', true);

        const path = '/data/value.txt';
        const file = await fs.createFile(path);

        await file.write(encoder.encode('first'));
        await file.setPos(0);
        await file.write(encoder.encode('second'));

        // "second" (6 bytes) is longer than "first" (5), so positions 0-5 are
        // fully covered by the second write; the file ends up exactly "second".
        expect(decoder.decode(await fs.readFile(path))).toBe('second');
    });

    it('unlinks a file so it can no longer be read', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/tmp', true);

        const path = '/tmp/disposable.txt';
        await fs.createDirectory(path);
        await fs.writeFile(path, encoder.encode('temporary'));

        expect(decoder.decode(await fs.readFile(path))).toBe('temporary');

        await fs.unlink(path);

        await expect(fs.readFile(path)).rejects.toBeDefined();
        expect(await fs.readDirectory('/tmp')).not.toContain('disposable.txt');
    });

    it('reports highestBlockId climbing as the filesystem allocates blocks', async () => {
        const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);

        // Fresh device: nothing allocated yet.
        expect(await blockDevice.getHighestBlockId()).toBe(-1);

        // After format(), at least the superblock + the inode-bitmap blocks
        // have been written, so the highest allocated ID is no longer -1.
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const highestAfterFormat = await blockDevice.getHighestBlockId();
        expect(highestAfterFormat).toBeGreaterThanOrEqual(0);

        // Creating real content should push the high-water mark up further.
        const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const fs = new KvFilesystemEasy(filesystem, '/');
        await fs.createDirectory('/data', true);
        const file = await fs.createFile('/data/note.txt');
        await file.write(encoder.encode(faker.lorem.paragraph()));

        expect(await blockDevice.getHighestBlockId()).toBeGreaterThan(highestAfterFormat);
    });
});
