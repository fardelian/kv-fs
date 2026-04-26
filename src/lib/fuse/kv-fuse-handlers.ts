import { KvFilesystemEasy } from '../filesystem';
import { KvError_INode_KindMismatch, KvINodeFile } from '../inode';
import { KvError_FS_Exists, KvError_FS_NotFound } from '../utils';

/**
 * Subset of POSIX-ish file attributes that any FUSE binding's `getattr`
 * callback wants. All numbers are conventional Unix values; modes use
 * the standard octal bits (`0o100644` = regular file rw-r--r--,
 * `0o040755` = directory rwxr-xr-x).
 */
export interface KvFuseAttr {
    mode: number;
    size: number;
    mtime: Date;
    ctime: Date;
    atime: Date;
    nlink: number;
    uid: number;
    gid: number;
    blksize: number;
}

/**
 * Errno values for FUSE callbacks. FUSE uses negative errno values
 * (`-Fuse.ENOENT` etc.) — but the actual numeric values are platform-
 * specific, and a real FUSE binding exposes them as constants. We
 * stick with descriptive names here and let the fuse-native (or
 * winfsp) wrapper translate at the boundary.
 */
export class KvFuseError extends Error {
    constructor(public readonly code: KvFuseErrorCode, message?: string) {
        super(message ?? code);
        this.name = 'KvFuseError';
    }
}

/**
 * Errno codes:
 *   ENOENT — no such file/directory
 *   EEXIST — already exists
 *   EISDIR — is a directory
 *   ENOTDIR — is not a directory
 *   EBADF — bad file handle
 *   ENOSYS — not implemented
 *   EIO — I/O error
 */
export type KvFuseErrorCode
    = 'ENOENT'
        | 'EEXIST'
        | 'EISDIR'
        | 'ENOTDIR'
        | 'EBADF'
        | 'ENOSYS'
        | 'EIO';

/**
 * Filesystem-level adapter from `KvFilesystemEasy` to FUSE-shape
 * callbacks. Pure async API — the actual FUSE library binding (e.g.
 * `fuse-native` on Linux/macOS, `winfsp` on Windows) wraps each method
 * in its own callback shape at the boundary.
 *
 * **File handle model**: a process opens a file → FUSE returns an
 * integer handle → subsequent reads/writes use it. We track open files
 * in a Map keyed on a monotonic counter; release/closes drop the entry.
 * Multiple opens of the same path get distinct handles, each with their
 * own KvINodeFile cursor.
 *
 * **Limitations** (POC scaffold):
 * - No `rmdir` — the underlying KvFilesystem doesn't implement directory
 *   removal yet.
 * - No `rename` — same reason.
 * - No symlinks, hardlinks, xattrs.
 * - `getattr` returns synthetic mode/uid/gid since we don't track those.
 */
export class KvFuseHandlers {
    private readonly fs: KvFilesystemEasy;
    private readonly openFiles = new Map<number, { path: string; file: KvINodeFile }>();
    private nextFh = 1;
    private readonly blockSize: number;

    constructor(fs: KvFilesystemEasy, blockSize = 4096) {
        this.fs = fs;
        this.blockSize = blockSize;
    }

    /**
     * `getattr(path)` — file/dir metadata for `stat()`.
     *
     * Disambiguating file vs directory: the inode's kind byte (added
     * in format v4) decides. We try the file path first and force
     * init() by reading 0 bytes. KvINodeFile.init() reads the kind
     * byte and throws KvError_INode_KindMismatch if the inode is
     * actually a directory — that's the cue to retry as a directory.
     */
    public async getattr(path: string): Promise<KvFuseAttr> {
        // The root path has no leaf, so it can't be a file. Skip straight
        // to the directory branch below.
        const isRoot = path === '/' || path === '';
        if (!isRoot) {
            try {
                const file = await this.fs.getKvFile(path);
                // Force init() so the kind byte is checked.
                await file.read(0);
                return {
                    mode: 0o100644,
                    size: file.size,
                    mtime: file.modificationTime,
                    ctime: file.creationTime,
                    atime: file.modificationTime,
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    blksize: this.blockSize,
                };
            } catch (err) {
                if (err instanceof KvError_INode_KindMismatch) {
                    // It's a directory; fall through.
                } else if (err instanceof KvError_FS_NotFound) {
                    throw new KvFuseError('ENOENT', `Path "${path}" not found.`);
                } else {
                    throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
                }
            }
        }

        try {
            const dir = await this.fs.getDirectory(path);
            // Force init() so the kind byte is checked and timestamps are populated.
            await dir.read();
            return {
                mode: 0o040755,
                size: this.blockSize,
                mtime: dir.modificationTime,
                ctime: dir.creationTime,
                atime: dir.modificationTime,
                nlink: 2,
                uid: 0,
                gid: 0,
                blksize: this.blockSize,
            };
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Path "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /** `readdir(path)` — list directory entries (not including `.` and `..`). */
    public async readdir(path: string): Promise<string[]> {
        try {
            return await this.fs.readDirectory(path);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Directory "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /** `open(path)` — return a file handle for subsequent reads/writes. */
    public async open(path: string): Promise<number> {
        try {
            const file = await this.fs.getKvFile(path);
            const fh = this.nextFh++;
            this.openFiles.set(fh, { path, file });
            return fh;
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `File "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * `create(path)` — atomically create a new file and return an open
     * handle. `EEXIST` on conflict.
     */
    public async create(path: string): Promise<number> {
        try {
            await this.fs.createFile(path);
        } catch (err) {
            if (err instanceof KvError_FS_Exists) {
                throw new KvFuseError('EEXIST', `File "${path}" already exists.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
        return await this.open(path);
    }

    /** `read(fh, length, position)` — returns bytes read. */
    public async read(fh: number, length: number, position: number): Promise<Uint8Array> {
        const handle = this.requireFh(fh);
        await handle.file.setPos(position);
        return await handle.file.read(length);
    }

    /** `write(fh, data, position)` — returns bytes written. */
    public async write(fh: number, data: Uint8Array, position: number): Promise<number> {
        const handle = this.requireFh(fh);
        await handle.file.setPos(position);
        await handle.file.write(data);
        return data.length;
    }

    /** `release(fh)` — close file handle. Idempotent. */
    public async release(fh: number): Promise<void> {
        // Releasing an already-closed FH is a no-op; FUSE may double-close on error paths.
        await Promise.resolve();
        this.openFiles.delete(fh);
    }

    /** `unlink(path)` — delete a regular file. */
    public async unlink(path: string): Promise<void> {
        try {
            await this.fs.unlink(path);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `File "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /** `mkdir(path)` — create a directory. */
    public async mkdir(path: string): Promise<void> {
        try {
            await this.fs.createDirectory(path);
        } catch (err) {
            if (err instanceof KvError_FS_Exists) {
                throw new KvFuseError('EEXIST', `Directory "${path}" already exists.`);
            }
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Parent of "${path}" does not exist.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /** `truncate(path, size)` — set the file's size; extending zero-fills, shrinking discards. */
    public async truncate(path: string, size: number): Promise<void> {
        try {
            const file = await this.fs.getKvFile(path);
            await file.truncate(size);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `File "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /** `rmdir` — not yet supported by the underlying KvFilesystem. */
    public async rmdir(path: string): Promise<void> {
        await Promise.resolve();
        throw new KvFuseError('ENOSYS', `rmdir of "${path}" is not implemented in KvFilesystem yet.`);
    }

    /** `rename` — not yet supported by the underlying KvFilesystem. */
    public async rename(from: string, to: string): Promise<void> {
        await Promise.resolve();
        throw new KvFuseError('ENOSYS', `rename of "${from}" → "${to}" is not implemented in KvFilesystem yet.`);
    }

    private requireFh(fh: number): { path: string; file: KvINodeFile } {
        const handle = this.openFiles.get(fh);
        if (!handle) {
            throw new KvFuseError('EBADF', `Unknown file handle ${fh}.`);
        }
        return handle;
    }
}
