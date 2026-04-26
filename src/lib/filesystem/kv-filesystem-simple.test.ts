import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvFilesystem, KvFilesystemSimple } from '.';
import { KvError_FS_Exists, KvError_FS_NotEmpty, KvError_FS_NotFound } from '../utils';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 256;
const TOTAL_INODES = 64;
const SUPER_BLOCK_ID = 0;

async function makeFs(separator?: string): Promise<KvFilesystemSimple> {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(device, TOTAL_INODES);
    const filesystem = new KvFilesystem(device, SUPER_BLOCK_ID);
    return separator === undefined
        ? new KvFilesystemSimple(filesystem)
        : new KvFilesystemSimple(filesystem, separator);
}

describe('KvFilesystemSimple', () => {
    describe('constructor', () => {
        it('defaults the separator to "/" when none is supplied', async () => {
            const fs = await makeFs();
            // The default-arg branch only fires when the second argument is
            // omitted entirely. After that, ordinary slash-paths must work.
            await fs.createDirectory('/a', true);
            expect(await fs.readDirectory('/')).toContain('a');
        });

        it('accepts a custom separator', async () => {
            const fs = await makeFs(':');
            await fs.createDirectory(':custom:nested', true);
            expect(await fs.readDirectory(':custom')).toContain('nested');
        });
    });

    describe('createFile', () => {
        it('creates a file at the given absolute path', async () => {
            const fs = await makeFs();
            await fs.createFile('/note.txt');

            expect(await fs.readDirectory('/')).toContain('note.txt');
        });

        it('throws KvError_FS_Exists when the file already exists', async () => {
            const fs = await makeFs();
            await fs.createFile('/note.txt');

            await expect(fs.createFile('/note.txt')).rejects.toBeInstanceOf(KvError_FS_Exists);
        });
    });

    describe('createDirectory', () => {
        it('throws when called with the root path "/" (no leaf component)', async () => {
            const fs = await makeFs();

            await expect(fs.createDirectory('/')).rejects.toBeInstanceOf(KvError_FS_Exists);
        });

        it('throws when an intermediate directory is missing and createPath is false', async () => {
            const fs = await makeFs();

            await expect(fs.createDirectory('/missing/leaf', false)).rejects.toBeInstanceOf(KvError_FS_NotFound);
        });

        it('creates intermediate directories when createPath is true', async () => {
            const fs = await makeFs();

            await fs.createDirectory('/a/b/c', true);

            expect(await fs.readDirectory('/')).toContain('a');
            expect(await fs.readDirectory('/a')).toContain('b');
            expect(await fs.readDirectory('/a/b')).toContain('c');
        });
    });

    describe('getDirectory', () => {
        it('returns the root directory for "/"', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/a', true);

            const root = await fs.getDirectory('/');

            expect(Array.from((await root.read()).keys())).toContain('a');
        });

        it('handles trailing slashes (treats "/a/" the same as "/a")', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/a', true);
            await fs.createDirectory('/a/b', true);

            const dir = await fs.getDirectory('/a/');

            expect(Array.from((await dir.read()).keys())).toContain('b');
        });

        it('handles consecutive separators ("/a//b" same as "/a/b")', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/a/b', true);

            const dir = await fs.getDirectory('/a//b');

            expect(dir).toBeDefined();
        });
    });

    describe('readFile / writeFile', () => {
        it('writeFile truncates and overwrites; readFile returns the new bytes', async () => {
            const fs = await makeFs();
            const file = await fs.createFile('/note.txt');
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();

            await file.write(encoder.encode('first long content'));
            await fs.writeFile('/note.txt', encoder.encode('short'));

            const after = await fs.readFile('/note.txt');
            expect(decoder.decode(after)).toBe('short');
        });
    });

    describe('unlink', () => {
        it('throws when the path has no leaf (root)', async () => {
            const fs = await makeFs();

            await expect(fs.unlink('/')).rejects.toBeInstanceOf(KvError_FS_Exists);
        });

        it('removes a file from its parent directory', async () => {
            const fs = await makeFs();
            await fs.createFile('/note.txt');

            await fs.unlink('/note.txt');

            expect(await fs.readDirectory('/')).not.toContain('note.txt');
        });
    });

    describe('getKvFile', () => {
        it('throws when the file does not exist', async () => {
            const fs = await makeFs();

            await expect(fs.getKvFile('/missing.txt')).rejects.toBeInstanceOf(KvError_FS_NotFound);
        });
    });

    describe('removeDirectory', () => {
        it('removes an empty directory at a path', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/parent/child', true);

            await fs.removeDirectory('/parent/child');

            expect(await fs.readDirectory('/parent')).not.toContain('child');
        });

        it('throws KvError_FS_NotEmpty when the directory still has entries', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/parent', true);
            await fs.createFile('/parent/note.txt');

            await expect(fs.removeDirectory('/parent')).rejects.toBeInstanceOf(KvError_FS_NotEmpty);
        });

        it('throws KvError_FS_NotFound when the path does not exist', async () => {
            const fs = await makeFs();

            await expect(fs.removeDirectory('/missing')).rejects.toBeInstanceOf(KvError_FS_NotFound);
        });
    });

    describe('rename', () => {
        it('renames a file within the same directory', async () => {
            const fs = await makeFs();
            const file = await fs.createFile('/old.txt');
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            await file.write(encoder.encode('hello'));

            await fs.rename('/old.txt', '/new.txt');

            expect(await fs.readDirectory('/')).toContain('new.txt');
            expect(await fs.readDirectory('/')).not.toContain('old.txt');
            expect(decoder.decode(await fs.readFile('/new.txt'))).toBe('hello');
        });

        it('moves a file across directories', async () => {
            const fs = await makeFs();
            await fs.createDirectory('/a', true);
            await fs.createDirectory('/b', true);
            const file = await fs.createFile('/a/note.txt');
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            await file.write(encoder.encode('moved'));

            await fs.rename('/a/note.txt', '/b/note.txt');

            expect(await fs.readDirectory('/a')).not.toContain('note.txt');
            expect(await fs.readDirectory('/b')).toContain('note.txt');
            expect(decoder.decode(await fs.readFile('/b/note.txt'))).toBe('moved');
        });

        it('throws KvError_FS_Exists when the destination already exists', async () => {
            const fs = await makeFs();
            await fs.createFile('/a.txt');
            await fs.createFile('/b.txt');

            await expect(fs.rename('/a.txt', '/b.txt')).rejects.toBeInstanceOf(KvError_FS_Exists);
        });
    });
});
