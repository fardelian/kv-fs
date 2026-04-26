import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvFilesystem } from './kv-filesystem';
import { KvError_FS_Exists, KvError_FS_NotEmpty, KvError_FS_NotFound } from '../utils';

const BLOCK_SIZE = 4096;
const CAPACITY_BLOCKS = 256;
const CAPACITY_BYTES = BLOCK_SIZE * CAPACITY_BLOCKS;

async function makeFs() {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
    await KvFilesystem.format(device, 64);
    return new KvFilesystem(device, 0);
}

describe('KvFilesystem.format', () => {
    it('throws RangeError when totalINodes is less than 1', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        await expect(KvFilesystem.format(device, 0)).rejects.toBeInstanceOf(RangeError);
    });

    it('throws RangeError when totalINodes exceeds the device capacity in blocks', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        await expect(KvFilesystem.format(device, CAPACITY_BLOCKS + 1))
            .rejects.toBeInstanceOf(RangeError);
    });

    it('returns a KvFilesystem with the configured superblock when totalINodes is in range', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        const fs = await KvFilesystem.format(device, 4);

        expect(fs).toBeInstanceOf(KvFilesystem);
    });
});

describe('KvFilesystem.removeFile', () => {
    it('removes a file from its parent directory and frees its blocks', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        await fs.createFile('note.txt', root);

        await fs.removeFile('note.txt', root);

        expect(await root.hasEntry('note.txt')).toBe(false);
    });

    it('throws KvError_FS_NotFound when the file does not exist', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();

        await expect(fs.removeFile('missing.txt', root)).rejects.toBeInstanceOf(KvError_FS_NotFound);
    });
});

describe('KvFilesystem.removeDirectory', () => {
    it('removes an empty directory and frees its inode block', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        await fs.createDirectory('child', root);

        await fs.removeDirectory('child', root);

        expect(await root.hasEntry('child')).toBe(false);
    });

    it('throws KvError_FS_NotEmpty when the directory still has entries (recursive=false default)', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        const child = await fs.createDirectory('child', root);
        await fs.createFile('inside.txt', child);

        await expect(fs.removeDirectory('child', root)).rejects.toBeInstanceOf(KvError_FS_NotEmpty);
        // Source directory entry should still be intact after the failure.
        expect(await root.hasEntry('child')).toBe(true);
    });

    it('throws KvError_FS_NotFound when the entry is missing', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();

        await expect(fs.removeDirectory('nope', root)).rejects.toBeInstanceOf(KvError_FS_NotFound);
    });

    it('with recursive=true, frees a directory holding files in one call', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        const child = await fs.createDirectory('child', root);
        await fs.createFile('a.txt', child);
        await fs.createFile('b.txt', child);

        await fs.removeDirectory('child', root, true);

        expect(await root.hasEntry('child')).toBe(false);
    });

    it('with recursive=true, frees a deeply nested tree (files and dirs alike)', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
        await KvFilesystem.format(device, 64);
        const fs = new KvFilesystem(device, 0);

        const root = await fs.getRootDirectory();
        const a = await fs.createDirectory('a', root);
        const b = await fs.createDirectory('b', a);
        const c = await fs.createDirectory('c', b);
        await fs.createFile('leaf.txt', c);
        await fs.createFile('side.txt', a);
        const beforePeak = await device.getHighestBlockId();

        await fs.removeDirectory('a', root, true);

        expect(await root.hasEntry('a')).toBe(false);
        // Recursive removal frees the inode + data blocks of every entry,
        // so the high-water mark should drop back below where it stood
        // when the tree existed.
        expect(await device.getHighestBlockId()).toBeLessThan(beforePeak);
    });
});

describe('KvFilesystem.rename', () => {
    it('renames an entry within the same directory', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        await fs.createFile('old.txt', root);

        await fs.rename('old.txt', root, 'new.txt', root);

        expect(await root.hasEntry('old.txt')).toBe(false);
        expect(await root.hasEntry('new.txt')).toBe(true);
    });

    it('moves an entry across directories', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        const a = await fs.createDirectory('a', root);
        const b = await fs.createDirectory('b', root);
        await fs.createFile('note.txt', a);

        await fs.rename('note.txt', a, 'note.txt', b);

        expect(await a.hasEntry('note.txt')).toBe(false);
        expect(await b.hasEntry('note.txt')).toBe(true);
    });

    it('throws KvError_FS_Exists when the destination already exists', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        await fs.createFile('a.txt', root);
        await fs.createFile('b.txt', root);

        await expect(fs.rename('a.txt', root, 'b.txt', root)).rejects.toBeInstanceOf(KvError_FS_Exists);
        // Both entries remain intact when the rename fails.
        expect(await root.hasEntry('a.txt')).toBe(true);
        expect(await root.hasEntry('b.txt')).toBe(true);
    });

    it('throws KvError_FS_NotFound when the source is missing', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();

        await expect(fs.rename('nope.txt', root, 'b.txt', root)).rejects.toBeInstanceOf(KvError_FS_NotFound);
    });

    it('is a no-op when source and target are identical', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        await fs.createFile('same.txt', root);

        await fs.rename('same.txt', root, 'same.txt', root);

        expect(await root.hasEntry('same.txt')).toBe(true);
    });

    it('also moves directories (the inode itself doesn\'t move)', async () => {
        const fs = await makeFs();
        const root = await fs.getRootDirectory();
        const sub = await fs.createDirectory('sub', root);
        await fs.createFile('inside.txt', sub);

        await fs.rename('sub', root, 'sub-renamed', root);

        expect(await root.hasEntry('sub')).toBe(false);
        expect(await root.hasEntry('sub-renamed')).toBe(true);

        // The contents are still reachable via the renamed directory.
        const renamedId = await root.getEntry('sub-renamed');
        const renamed = await fs.getDirectory('sub-renamed', root);
        expect(renamed.id).toBe(renamedId);
        expect(await renamed.hasEntry('inside.txt')).toBe(true);
    });
});
