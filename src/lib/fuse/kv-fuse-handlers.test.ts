import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../filesystem';
import { KvFuseError, KvFuseHandlers } from './kv-fuse-handlers';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 256;
const TOTAL_INODES = 64;
const SUPER_BLOCK_ID = 0;

async function makeHandlers(): Promise<{
    fs: KvFilesystemSimple;
    handlers: KvFuseHandlers;
}> {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(device, TOTAL_INODES);
    const fs = new KvFilesystemSimple(new KvFilesystem(device, SUPER_BLOCK_ID), '/');
    return { fs, handlers: new KvFuseHandlers(fs, BLOCK_SIZE) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('KvFuseHandlers', () => {
    describe('getattr', () => {
        it('reports a directory mode for the root', async () => {
            const { handlers } = await makeHandlers();
            const stat = await handlers.getattr('/');
            // 0o040755 = directory rwxr-xr-x
            expect(stat.mode).toBe(0o040755);
        });

        it('reports a regular-file mode and the actual size for a file', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/note.txt');
            await fs.writeFile('/note.txt', enc.encode('hello'));

            const stat = await handlers.getattr('/note.txt');

            expect(stat.mode).toBe(0o100644);
            expect(stat.size).toBe(5);
        });

        it('throws ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.getattr('/missing.txt'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('readdir', () => {
        it('lists entries (without . / ..)', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            await fs.createDirectory('/b');

            const entries = await handlers.readdir('/');

            expect(entries.sort()).toEqual(['a.txt', 'b']);
        });

        it('throws ENOENT on a missing directory', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.readdir('/nope')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('open / read / write / release', () => {
        it('round-trips data through open → write → read → release', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/data.bin');

            const fh = await handlers.open('/data.bin');
            const written = await handlers.write(fh, enc.encode('hello world'), 0);
            expect(written).toBe(11);

            const read = await handlers.read(fh, 11, 0);
            expect(dec.decode(read)).toBe('hello world');

            await handlers.release(fh);
        });

        it('release is idempotent', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/x.txt');
            const fh = await handlers.open('/x.txt');
            await handlers.release(fh);
            await expect(handlers.release(fh)).resolves.toBeUndefined();
        });

        it('reads at an offset return only what is available', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/offset.txt');
            const fh = await handlers.open('/offset.txt');
            await handlers.write(fh, enc.encode('0123456789'), 0);

            const slice = await handlers.read(fh, 100, 5); // ask for more than available
            expect(dec.decode(slice)).toBe('56789');
        });

        it('returns EBADF for an unknown file handle', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.read(999, 1, 0)).rejects.toMatchObject({ code: 'EBADF' });
            await expect(handlers.write(999, new Uint8Array(1), 0)).rejects.toMatchObject({ code: 'EBADF' });
        });

        it('returns ENOENT when opening a missing file', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.open('/nope.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('create', () => {
        it('creates a file and returns an open handle ready to receive writes', async () => {
            const { handlers } = await makeHandlers();

            const fh = await handlers.create('/new.txt');
            await handlers.write(fh, enc.encode('payload'), 0);

            const read = await handlers.read(fh, 7, 0);
            expect(dec.decode(read)).toBe('payload');
        });

        it('returns EEXIST when the file already exists', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/dup.txt');

            await expect(handlers.create('/dup.txt')).rejects.toMatchObject({ code: 'EEXIST' });
        });
    });

    describe('mkdir / unlink / truncate / rmdir / rename', () => {
        it('mkdir creates a directory, readdir reflects it', async () => {
            const { handlers } = await makeHandlers();
            await handlers.mkdir('/sub');
            const entries = await handlers.readdir('/');
            expect(entries).toContain('sub');
        });

        it('mkdir on a duplicate path returns EEXIST', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/sub');

            await expect(handlers.mkdir('/sub')).rejects.toMatchObject({ code: 'EEXIST' });
        });

        it('unlink removes a file', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/gone.txt');

            await handlers.unlink('/gone.txt');
            await expect(handlers.getattr('/gone.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('unlink on a missing file returns ENOENT', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.unlink('/missing.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('truncate sets the size; reading reflects it', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/big.txt');
            await fs.writeFile('/big.txt', enc.encode('hello world'));

            await handlers.truncate('/big.txt', 5);

            const stat = await handlers.getattr('/big.txt');
            expect(stat.size).toBe(5);
            const fh = await handlers.open('/big.txt');
            const data = await handlers.read(fh, 5, 0);
            expect(dec.decode(data)).toBe('hello');
        });

        it('rmdir returns ENOSYS (POC: directory removal not yet supported)', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/d');

            await expect(handlers.rmdir('/d')).rejects.toMatchObject({ code: 'ENOSYS' });
        });

        it('rename returns ENOSYS (POC: not yet supported)', async () => {
            const { handlers } = await makeHandlers();

            await expect(handlers.rename('/a', '/b')).rejects.toMatchObject({ code: 'ENOSYS' });
        });
    });

    describe('error class', () => {
        it('KvFuseError carries the errno code on .code', () => {
            const err = new KvFuseError('ENOENT', 'gone');
            expect(err.code).toBe('ENOENT');
            expect(err.message).toBe('gone');
            expect(err.name).toBe('KvFuseError');
        });
    });
});
