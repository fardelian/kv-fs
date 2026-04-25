import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemEasy } from '../lib/filesystem';
import { KvEncryptionRot13 } from '../lib/encryption';
import { INodeId } from '../lib/inode';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

interface PublicBlockDevice {
    blocks: Map<INodeId, Uint8Array>;
}

async function makeFs(): Promise<KvFilesystemEasy> {
    const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(blockDevice, TOTAL_BLOCKS, TOTAL_INODES);
    const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
    return new KvFilesystemEasy(filesystem, '/');
}

async function makeRot13Fs(): Promise<{ fs: KvFilesystemEasy; underlying: KvBlockDeviceMemory }> {
    const underlying = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    const encrypted = new KvEncryptedBlockDevice(underlying, new KvEncryptionRot13());
    await KvFilesystem.format(encrypted, TOTAL_BLOCKS, TOTAL_INODES);
    const filesystem = new KvFilesystem(encrypted, SUPER_BLOCK_ID);
    return { fs: new KvFilesystemEasy(filesystem, '/'), underlying };
}

/** Search every block of an in-memory device for the given byte sequence. */
function anyBlockContains(device: KvBlockDeviceMemory, needle: Uint8Array): boolean {
    const blocks = (device as unknown as PublicBlockDevice).blocks;
    for (const block of blocks.values()) {
        outer: for (let i = 0; i <= block.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (block[i + j] !== needle[j]) continue outer;
            }
            return true;
        }
    }
    return false;
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

    describe('with KvEncryptionRot13 layered between the filesystem and the device', () => {
        it('round-trips files transparently through the encryption layer', async () => {
            const { fs } = await makeRot13Fs();

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

        it('stores the rot13-encoded form on the underlying device, not the plaintext', async () => {
            const { fs, underlying } = await makeRot13Fs();
            await fs.createDirectory('/data', true);

            // Letters get shifted; the space passes through unchanged, which is
            // the point — it shows the cipher is genuinely byte-by-byte and
            // doesn't accidentally mangle non-letter bytes.
            const plaintext = 'hello world';
            const expectedCiphertext = 'uryyb jbeyq'; // ROT13(plaintext)

            const file = await fs.createFile('/data/note.txt');
            await file.write(encoder.encode(plaintext));

            expect(anyBlockContains(underlying, encoder.encode(plaintext))).toBe(false);
            expect(anyBlockContains(underlying, encoder.encode(expectedCiphertext))).toBe(true);
        });
    });
});
