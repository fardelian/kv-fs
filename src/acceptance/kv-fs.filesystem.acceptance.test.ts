import { describe, it, expect } from 'bun:test';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

async function makeFs(): Promise<KvFilesystemSimple> {
    const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(blockDevice, TOTAL_INODES);
    const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
    return new KvFilesystemSimple(filesystem, '/');
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
        await fs.createFile(path);
        await fs.writeFile(path, encoder.encode('temporary'));

        expect(decoder.decode(await fs.readFile(path))).toBe('temporary');

        await fs.removeFile(path);

        await expect(fs.readFile(path)).rejects.toBeDefined();
        expect(await fs.readDirectory('/tmp')).not.toContain('disposable.txt');
    });

    it('holds many files in a single directory (entries spill across chained blocks)', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/big', true);

        // 50 entries is well past the ~15-per-block limit of any single
        // directory block, so the directory inode must chain into multiple
        // continuation blocks under the hood. Callers should see one flat
        // listing regardless.
        const FILE_COUNT = 50;
        for (let i = 0; i < FILE_COUNT; i++) {
            const file = await fs.createFile(`/big/file-${String(i).padStart(3, '0')}.txt`);
            await file.write(encoder.encode(`payload-${i}`));
        }

        const listing = await fs.readDirectory('/big');
        expect(listing.length).toBe(FILE_COUNT);
        for (let i = 0; i < FILE_COUNT; i++) {
            expect(listing).toContain(`file-${String(i).padStart(3, '0')}.txt`);
        }

        // Spot-check a few payloads from the middle and end of the chain.
        for (const i of [0, 17, 31, 49]) {
            const data = await fs.readFile(`/big/file-${String(i).padStart(3, '0')}.txt`);
            expect(decoder.decode(data)).toBe(`payload-${i}`);
        }
    });

    it('survives remount (re-init from same block device) with a chained directory', async () => {
        const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);

        // First "mount": create a directory with enough entries to require
        // continuation blocks, then walk away.
        {
            const fs = new KvFilesystemSimple(new KvFilesystem(blockDevice, SUPER_BLOCK_ID), '/');
            await fs.createDirectory('/persist', true);
            for (let i = 0; i < 30; i++) {
                const file = await fs.createFile(`/persist/note-${i}.txt`);
                await file.write(encoder.encode(`hello-${i}`));
            }
        }

        // Second "mount": fresh KvFilesystem against the same blocks. The
        // chained directory must be readable end-to-end — the chain pointer
        // and total entry count round-trip through disk.
        const fs2 = new KvFilesystemSimple(new KvFilesystem(blockDevice, SUPER_BLOCK_ID), '/');
        const listing = await fs2.readDirectory('/persist');
        expect(listing.length).toBe(30);

        for (let i = 0; i < 30; i++) {
            const data = await fs2.readFile(`/persist/note-${i}.txt`);
            expect(decoder.decode(data)).toBe(`hello-${i}`);
        }
    });

    it('shrinks a chained directory back to a single block after enough unlinks', async () => {
        const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const fs = new KvFilesystemSimple(new KvFilesystem(blockDevice, SUPER_BLOCK_ID), '/');

        await fs.createDirectory('/shrink', true);
        // Grow to 40 entries, forcing continuation blocks.
        for (let i = 0; i < 40; i++) {
            await fs.createFile(`/shrink/file-${i}.txt`);
        }
        const peakHighWaterMark = await blockDevice.getHighestBlockId();

        // Remove down to 5 — well within first-block capacity.
        for (let i = 5; i < 40; i++) {
            await fs.removeFile(`/shrink/file-${i}.txt`);
        }

        const listing = await fs.readDirectory('/shrink');
        expect(listing.length).toBe(5);

        // Continuation blocks were freed when the directory shrank, so the
        // device should be using fewer blocks than at peak.
        const finalHighWaterMark = await blockDevice.getHighestBlockId();
        expect(finalHighWaterMark).toBeLessThan(peakHighWaterMark);
    });

    it('rmdir + rename: rearrange a tree, contents preserved', async () => {
        const fs = await makeFs();

        await fs.createDirectory('/projects/alpha', true);
        await fs.createDirectory('/projects/beta', true);
        const file = await fs.createFile('/projects/alpha/notes.txt');
        await file.write(encoder.encode('alpha-original'));

        // Rename across directories — the file's bytes survive intact.
        await fs.rename('/projects/alpha/notes.txt', '/projects/beta/notes.txt');
        expect(await fs.readDirectory('/projects/alpha')).not.toContain('notes.txt');
        expect(decoder.decode(await fs.readFile('/projects/beta/notes.txt'))).toBe('alpha-original');

        // Now alpha is empty — rmdir should succeed.
        await fs.removeDirectory('/projects/alpha');
        expect(await fs.readDirectory('/projects')).not.toContain('alpha');
        expect(await fs.readDirectory('/projects')).toContain('beta');

        // Rename a directory itself; contents reachable via new path.
        await fs.rename('/projects/beta', '/projects/gamma');
        expect(await fs.readDirectory('/projects')).toEqual(['gamma']);
        expect(decoder.decode(await fs.readFile('/projects/gamma/notes.txt'))).toBe('alpha-original');

        // Cleanup: empty gamma, rmdir it, rmdir projects.
        await fs.removeFile('/projects/gamma/notes.txt');
        await fs.removeDirectory('/projects/gamma');
        await fs.removeDirectory('/projects');
        expect(await fs.readDirectory('/')).not.toContain('projects');
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
        const fs = new KvFilesystemSimple(filesystem, '/');
        await fs.createDirectory('/data', true);
        const file = await fs.createFile('/data/note.txt');
        await file.write(encoder.encode(faker.lorem.paragraph()));

        expect(await blockDevice.getHighestBlockId()).toBeGreaterThan(highestAfterFormat);
    });

    it('readPartial / writePartial: byte-addressable I/O without touching position', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/data', true);

        const file = await fs.createFile('/data/buffer.bin');
        // Lay down a 1.5-block-sized payload so partial ops cross block
        // boundaries and exercise the per-block dispatch in readPartial /
        // writePartial.
        const total = Math.floor(BLOCK_SIZE * 1.5);
        const payload = new Uint8Array(total);
        for (let i = 0; i < total; i++) payload[i] = i & 0xff;
        await file.write(payload);
        const positionAfterWrite = file.getPos();

        // readPartial pulls a slice that straddles the block boundary
        // and leaves the cursor where write() left it.
        const slice = await file.readPartial(BLOCK_SIZE - 8, 32);
        expect(slice.length).toBe(32);
        for (let i = 0; i < 32; i++) {
            expect(slice[i]).toBe((BLOCK_SIZE - 8 + i) & 0xff);
        }
        expect(file.getPos()).toBe(positionAfterWrite);

        // writePartial splices a fixed pattern over the same range and
        // (again) leaves the cursor untouched.
        const patch = new Uint8Array(32);
        patch.fill(0xab);
        await file.writePartial(BLOCK_SIZE - 8, patch);
        expect(file.getPos()).toBe(positionAfterWrite);

        // Verify the splice via a fresh full read.
        await file.setPos(0);
        const after = await file.read();
        expect(after.length).toBe(total);
        for (let i = 0; i < BLOCK_SIZE - 8; i++) {
            expect(after[i]).toBe(i & 0xff);
        }
        for (let i = BLOCK_SIZE - 8; i < BLOCK_SIZE - 8 + 32; i++) {
            expect(after[i]).toBe(0xab);
        }
        for (let i = BLOCK_SIZE - 8 + 32; i < total; i++) {
            expect(after[i]).toBe(i & 0xff);
        }
    });

    it('readPartial caps at EOF; writePartial extends past it', async () => {
        const fs = await makeFs();
        await fs.createDirectory('/data', true);

        const file = await fs.createFile('/data/grow.bin');
        await file.write(encoder.encode('hello'));

        // Read past EOF — only the in-range bytes come back, nothing
        // extends.
        const tail = await file.readPartial(2, 100);
        expect(decoder.decode(tail)).toBe('llo');

        // Reading entirely past EOF: empty.
        expect((await file.readPartial(50, 10)).length).toBe(0);

        // Write past EOF — the file grows; bytes between the old EOF
        // and the new write are zero-filled (the inode's resize() does
        // that).
        await file.writePartial(10, encoder.encode('XYZ'));
        await file.setPos(0);
        const all = await file.read();
        expect(all.length).toBe(13);
        expect(decoder.decode(all.subarray(0, 5))).toBe('hello');
        for (let i = 5; i < 10; i++) expect(all[i]).toBe(0);
        expect(decoder.decode(all.subarray(10))).toBe('XYZ');
    });
});
