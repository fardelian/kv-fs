import { describe, it, expect, jest } from '@jest/globals';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../filesystem';
import { KvError_FS_NotFound } from '../utils';
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
    describe('constructor', () => {
        it('uses 4096 as the default blockSize when none is given', async () => {
            const device = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
            await KvFilesystem.format(device, TOTAL_INODES);
            const fs = new KvFilesystemSimple(new KvFilesystem(device, SUPER_BLOCK_ID), '/');
            const handlers = new KvFuseHandlers(fs);

            const stat = await handlers.getattr('/');
            expect(stat.blksize).toBe(4096);
        });
    });

    describe('getattr', () => {
        it('reports a directory mode for the root', async () => {
            const { handlers } = await makeHandlers();
            const stat = await handlers.getattr('/');
            // 0o040777 = directory rwxrwxrwx — the kv-fs inode doesn't
            // store mode bits yet, so we report wide-open access until
            // chmod / access semantics land.
            expect(stat.mode).toBe(0o040777);
        });

        it('reports a regular-file mode and the actual size for a file', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/note.txt');
            await fs.writeFile('/note.txt', enc.encode('hello'));

            const stat = await handlers.getattr('/note.txt');

            // 0o100777 = regular file rwxrwxrwx (see above).
            expect(stat.mode).toBe(0o100777);
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

        it('rmdir removes an empty directory', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/d');

            await handlers.rmdir('/d');

            expect(await fs.readDirectory('/')).not.toContain('d');
        });

        it('rmdir returns ENOTEMPTY when the directory still has entries', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/d', true);
            await fs.createFile('/d/file.txt');

            await expect(handlers.rmdir('/d')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
        });

        it('rmdir returns ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.rmdir('/missing')).rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('rename moves a file within the same directory', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/old.txt');
            await fs.writeFile('/old.txt', enc.encode('hello'));

            await handlers.rename('/old.txt', '/new.txt');

            expect(await fs.readDirectory('/')).toContain('new.txt');
            expect(await fs.readDirectory('/')).not.toContain('old.txt');
            expect(dec.decode(await fs.readFile('/new.txt'))).toBe('hello');
        });

        it('rename moves a file across directories', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/a', true);
            await fs.createDirectory('/b', true);
            await fs.createFile('/a/note.txt');
            await fs.writeFile('/a/note.txt', enc.encode('payload'));

            await handlers.rename('/a/note.txt', '/b/note.txt');

            expect(await fs.readDirectory('/a')).not.toContain('note.txt');
            expect(await fs.readDirectory('/b')).toContain('note.txt');
            expect(dec.decode(await fs.readFile('/b/note.txt'))).toBe('payload');
        });

        it('rename returns EEXIST when the destination already exists', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            await fs.createFile('/b.txt');

            await expect(handlers.rename('/a.txt', '/b.txt')).rejects.toMatchObject({ code: 'EEXIST' });
        });

        it('rename returns ENOENT when the source is missing', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.rename('/nope.txt', '/b.txt')).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('error class', () => {
        it('KvFuseError carries the errno code on .code', () => {
            const err = new KvFuseError('ENOENT', 'gone');
            expect(err.code).toBe('ENOENT');
            expect(err.message).toBe('gone');
            expect(err.name).toBe('KvFuseError');
        });

        it('KvFuseError defaults its message to the errno code when none is given', () => {
            const err = new KvFuseError('EBADF');
            expect(err.message).toBe('EBADF');
        });
    });

    describe('access / utimens / chmod / chown', () => {
        it('access succeeds on a path that exists (file)', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');

            await expect(handlers.access('/a.txt')).resolves.toBeUndefined();
        });

        it('access succeeds on the root directory', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.access('/')).resolves.toBeUndefined();
        });

        it('access throws ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.access('/missing.txt'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('utimens persists mtime on a file (atime is silently ignored)', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            const target = new Date('2022-03-04T05:06:07Z');

            await handlers.utimens('/a.txt', new Date(0), target);

            const stat = await handlers.getattr('/a.txt');
            expect(stat.mtime.getTime()).toBe(target.getTime());
        });

        it('utimens persists mtime on a directory', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/sub', true);
            const target = new Date('2024-01-01T00:00:00Z');

            await handlers.utimens('/sub', new Date(0), target);

            const stat = await handlers.getattr('/sub');
            expect(stat.mtime.getTime()).toBe(target.getTime());
        });

        it('utimens persists mtime on the root directory (no-leaf branch)', async () => {
            const { handlers } = await makeHandlers();
            const target = new Date('2025-07-08T09:10:11Z');

            await handlers.utimens('/', new Date(0), target);

            const stat = await handlers.getattr('/');
            expect(stat.mtime.getTime()).toBe(target.getTime());
        });

        it('utimens throws ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.utimens('/missing.txt', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('chmod silently accepts on an existing path', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');

            await expect(handlers.chmod('/a.txt', 0o600)).resolves.toBeUndefined();
        });

        it('chmod returns ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.chmod('/missing.txt', 0o600))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('chown silently accepts on an existing path', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');

            await expect(handlers.chown('/a.txt', 1000, 1000)).resolves.toBeUndefined();
        });

        it('chown returns ENOENT for a missing path', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.chown('/missing.txt', 1000, 1000))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('flush / fsync / statfs', () => {
        it('flush is a no-op on an open file handle', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            const fh = await handlers.open('/a.txt');

            await expect(handlers.flush(fh)).resolves.toBeUndefined();
        });

        it('flush throws EBADF on an unknown handle', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.flush(99)).rejects.toMatchObject({ code: 'EBADF' });
        });

        it('fsync is a no-op on an open file handle', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            const fh = await handlers.open('/a.txt');

            await expect(handlers.fsync(fh)).resolves.toBeUndefined();
            await expect(handlers.fsync(fh, true)).resolves.toBeUndefined();
        });

        it('fsync throws EBADF on an unknown handle', async () => {
            const { handlers } = await makeHandlers();
            await expect(handlers.fsync(99)).rejects.toMatchObject({ code: 'EBADF' });
        });

        it('statfs reports volume capacity', async () => {
            const { handlers } = await makeHandlers();
            const stat = await handlers.statfs();

            expect(stat.blockSize).toBeGreaterThan(0);
            expect(stat.totalBlocks).toBeGreaterThan(0);
            expect(stat.usedBlocks + stat.freeBlocks).toBe(stat.totalBlocks);
        });

        it('statfs accepts the optional path argument', async () => {
            const { handlers } = await makeHandlers();
            const stat = await handlers.statfs('/anything');
            expect(stat.totalBlocks).toBeGreaterThan(0);
        });
    });

    describe('mode argument on create / mkdir', () => {
        it('create accepts an explicit mode argument and returns a usable handle', async () => {
            const { handlers } = await makeHandlers();
            const fh = await handlers.create('/note.txt', 0o600);
            expect(fh).toBeGreaterThan(0);
        });

        it('mkdir accepts an explicit mode argument', async () => {
            const { fs, handlers } = await makeHandlers();
            await handlers.mkdir('/sub', 0o700);
            expect(await fs.readDirectory('/')).toContain('sub');
        });
    });

    describe('EIO fallback — unrecognised errors from the underlying filesystem map to EIO', () => {
        // The handlers translate KvError_FS_NotFound / Exists / NotEmpty
        // into the matching errno. Anything else falls through to a
        // generic EIO. We exercise that fall-through by spying on the
        // underlying fs methods and forcing them to throw a plain Error.
        const unrelated = new Error('disk on fire');

        it('getattr (file branch) returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.getattr('/a.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'disk on fire' });
        });

        it('getattr (directory branch) returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(unrelated);

            await expect(handlers.getattr('/'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('readdir returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'readDirectory').mockRejectedValueOnce(unrelated);

            await expect(handlers.readdir('/'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('readdir EIO falls back to String(err) when err is not an Error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'readDirectory').mockRejectedValueOnce('plain string');

            await expect(handlers.readdir('/'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain string' });
        });

        it('open returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/o.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.open('/o.txt'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('create returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'createFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.create('/c.txt'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('unlink returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/u.txt');
            jest.spyOn(fs, 'removeFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.unlink('/u.txt'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('mkdir returns ENOENT when the parent does not exist', async () => {
            const { handlers } = await makeHandlers();

            await expect(handlers.mkdir('/missing/sub'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('mkdir returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'createDirectory').mockRejectedValueOnce(unrelated);

            await expect(handlers.mkdir('/m'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('truncate returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/t.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.truncate('/t.txt', 5))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('rmdir returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/d');
            jest.spyOn(fs, 'removeDirectory').mockRejectedValueOnce(unrelated);

            await expect(handlers.rmdir('/d'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('rename returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/from.txt');
            jest.spyOn(fs, 'rename').mockRejectedValueOnce(unrelated);

            await expect(handlers.rename('/from.txt', '/to.txt'))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('utimens (file branch) returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/uf.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(unrelated);

            await expect(handlers.utimens('/uf.txt', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('utimens (directory branch) returns EIO on an unrelated error', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(unrelated);

            await expect(handlers.utimens('/', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'EIO' });
        });

        it('truncate on a missing path returns ENOENT', async () => {
            const { handlers } = await makeHandlers();

            await expect(handlers.truncate('/missing.txt', 0))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    describe('EIO message stringification — non-Error rejections route through String(err)', () => {
        // Every EIO fallback shape is `err instanceof Error ? err.message : String(err)`.
        // The Error branch is covered above; this group covers the String(err) branch
        // for each handler that has its own EIO catch.
        const stringErr: unknown = 'plain non-error';

        it('getattr (file branch) stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/a.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.getattr('/a.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('getattr (directory branch) stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(stringErr);

            await expect(handlers.getattr('/'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('open stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/o.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.open('/o.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('create stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'createFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.create('/c.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('unlink stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/u.txt');
            jest.spyOn(fs, 'removeFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.unlink('/u.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('mkdir stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'createDirectory').mockRejectedValueOnce(stringErr);

            await expect(handlers.mkdir('/m'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('truncate stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/t.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.truncate('/t.txt', 5))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('rmdir stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createDirectory('/d');
            jest.spyOn(fs, 'removeDirectory').mockRejectedValueOnce(stringErr);

            await expect(handlers.rmdir('/d'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('rename stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/r.txt');
            jest.spyOn(fs, 'rename').mockRejectedValueOnce(stringErr);

            await expect(handlers.rename('/r.txt', '/s.txt'))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('utimens (file branch) stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            await fs.createFile('/uf.txt');
            jest.spyOn(fs, 'getKvFile').mockRejectedValueOnce(stringErr);

            await expect(handlers.utimens('/uf.txt', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });

        it('utimens (directory branch) stringifies non-Error rejections', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(stringErr);

            await expect(handlers.utimens('/', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'EIO', message: 'plain non-error' });
        });
    });

    describe('directory-branch ENOENT mapping (rare paths exposed via spies)', () => {
        // The "directory branch" is hard to reach naturally without first
        // tripping the file-branch's own NotFound. We spy on the
        // underlying fs so the dir-branch lookup throws NotFound directly.
        const notFound = new KvError_FS_NotFound('synthetic missing');

        it('getattr (directory branch) maps NotFound to ENOENT', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(notFound);

            await expect(handlers.getattr('/'))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });

        it('utimens (directory branch) maps NotFound to ENOENT', async () => {
            const { fs, handlers } = await makeHandlers();
            jest.spyOn(fs, 'getDirectory').mockRejectedValueOnce(notFound);

            await expect(handlers.utimens('/', new Date(0), new Date()))
                .rejects.toMatchObject({ code: 'ENOENT' });
        });
    });
});
