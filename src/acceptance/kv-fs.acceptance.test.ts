import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

async function makeFs(): Promise<KvFilesystemEasy> {
    const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE);
    await KvFilesystem.format(blockDevice, TOTAL_BLOCKS, TOTAL_INODES);
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
        await fs.createFile('/home/florin/note.txt');

        const root = await fs.readDirectory('/');
        const home = await fs.readDirectory('/home');
        const florin = await fs.readDirectory('/home/florin');

        expect(root).toContain('home');
        expect(home).toContain('florin');
        expect(florin).toContain('note.txt');
    });

    it('overwrites a file (second write wins)', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/data', true);

        const path = '/data/value.txt';
        const file = await fs.createFile(path);

        await file.write(encoder.encode('first'));
        await file.write(encoder.encode('second'));

        expect(decoder.decode(await fs.readFile(path))).toBe('second');
    });

    it('unlinks a file so it can no longer be read', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/tmp', true);

        const path = '/tmp/disposable.txt';
        const file = await fs.createFile(path);
        await file.write(encoder.encode('temporary'));

        expect(decoder.decode(await fs.readFile(path))).toBe('temporary');

        await fs.unlink(path);

        await expect(fs.readFile(path)).rejects.toBeDefined();
        expect(await fs.readDirectory('/tmp')).not.toContain('disposable.txt');
    });
});
