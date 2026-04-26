import { KvFilesystemStat, KvFilesystemSimple } from '../filesystem';
import { KvINodeDirectory, KvINodeFile } from '../inode';
import { KvError_FS_Exists, KvError_FS_NotEmpty, KvError_FS_NotFound, KvError_INode_KindMismatch } from '../utils';

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
 *   ENOENT    — no such file/directory
 *   EEXIST    — already exists
 *   EISDIR    — is a directory
 *   ENOTDIR   — is not a directory
 *   ENOTEMPTY — directory not empty (rmdir only)
 *   EBADF     — bad file handle
 *   ENOSYS    — not implemented
 *   EIO       — I/O error
 */
export type KvFuseErrorCode
    = 'ENOENT'
        | 'EEXIST'
        | 'EISDIR'
        | 'ENOTDIR'
        | 'ENOTEMPTY'
        | 'EBADF'
        | 'ENOSYS'
        | 'EIO';

/**
 * Filesystem-level adapter from `KvFilesystemSimple` to FUSE-shape
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
 * - No symlinks, hardlinks, xattrs.
 * - `getattr` returns synthetic mode/uid/gid since we don't track those.
 */
export class KvFuseHandlers {
    private readonly fs: KvFilesystemSimple;
    private readonly openFiles = new Map<number, { path: string; file: KvINodeFile }>();
    private nextFh = 1;
    private readonly blockSize: number;

    constructor(fs: KvFilesystemSimple, blockSize = 4096) {
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
                    // 0o100777: regular file, full rwx for everyone. The
                    // kv-fs inode doesn't store mode bits (we'll add them
                    // later); until then we return wide-open so chmod /
                    // access don't fight whatever the OS expects.
                    mode: 0o100777,
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
                // 0o040777: directory, full rwx for everyone (see above).
                mode: 0o040777,
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

    /** List entries in a directory; does not include `.` or `..`. */
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

    /** Open a file and return a handle (small monotonic integer) for subsequent I/O. */
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
     * `create(path, mode)` — atomically create a new file and return
     * an open handle. `EEXIST` on conflict. The kernel passes the
     * requested permission bits in `mode`; we accept the parameter so
     * the FUSE binding's signature lines up but ignore the value
     * because the kv-fs inode doesn't carry mode bits yet.
     */
    public async create(path: string, _mode = 0o666): Promise<number> {
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

    /** Delete a regular file. */
    public async unlink(path: string): Promise<void> {
        try {
            await this.fs.removeFile(path);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `File "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * `mkdir(path, mode)` — create a directory. The kernel passes the
     * requested permission bits in `mode`; we accept the parameter to
     * line up with the FUSE binding signature but ignore the value
     * because the kv-fs inode doesn't carry mode bits yet.
     */
    public async mkdir(path: string, _mode = 0o777): Promise<void> {
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

    /** Remove an empty directory. POSIX `rmdir` semantics. */
    public async rmdir(path: string): Promise<void> {
        try {
            await this.fs.removeDirectory(path);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Directory "${path}" not found.`);
            }
            if (err instanceof KvError_FS_NotEmpty) {
                throw new KvFuseError('ENOTEMPTY', `Directory "${path}" is not empty.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * Move or rename a file/directory. POSIX `rename(2)` semantics —
     * but unlike POSIX, this implementation refuses to overwrite an
     * existing destination (returns `EEXIST`); caller must clear it
     * first.
     */
    public async rename(from: string, to: string): Promise<void> {
        try {
            await this.fs.rename(from, to);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Path "${from}" not found.`);
            }
            if (err instanceof KvError_FS_Exists) {
                throw new KvFuseError('EEXIST', `Path "${to}" already exists.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * `access(path, mode)` — POSIX `access(2)`. We don't track per-file
     * permissions, so the only thing this can meaningfully do is
     * confirm the path resolves; getattr does that already (and
     * throws ENOENT if not), so we just delegate. `mode` is ignored.
     */
    public async access(path: string, _mode = 0): Promise<void> {
        await this.getattr(path);
    }

    /**
     * `utimens(path, atime, mtime)` — POSIX `utimensat(2)` shape. The
     * kv-fs inode header only carries `creationTime` + `modificationTime`,
     * so `atime` is accepted but silently dropped; `mtime` is persisted.
     * Works for both files and directories; the dispatch matches the
     * one in {@link getattr}.
     */
    public async utimens(path: string, _atime: Date, mtime: Date): Promise<void> {
        const lower = this.fs.getFilesystem();
        const isRoot = path === '/' || path === '';
        if (!isRoot) {
            try {
                const file = await this.fs.getKvFile(path);
                await file.read(0); // force @Init so mtime read on next getattr is fresh
                await lower.touch(file, mtime);
                return;
            } catch (err) {
                if (err instanceof KvError_INode_KindMismatch) {
                    // Fall through to the directory branch.
                } else if (err instanceof KvError_FS_NotFound) {
                    throw new KvFuseError('ENOENT', `Path "${path}" not found.`);
                } else {
                    throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
                }
            }
        }
        try {
            const dir: KvINodeDirectory = await this.fs.getDirectory(path);
            await dir.read();
            await lower.touch(dir, mtime);
        } catch (err) {
            if (err instanceof KvError_FS_NotFound) {
                throw new KvFuseError('ENOENT', `Path "${path}" not found.`);
            }
            throw new KvFuseError('EIO', err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * `chmod(path, mode)` — accepted and silently ignored. The kv-fs
     * inode doesn't carry mode bits yet (full-access is reported by
     * {@link getattr}); returning success keeps `chmod` calls from
     * surfacing spurious errors. Will gain real semantics when the
     * inode header is widened.
     */
    public async chmod(path: string, _mode: number): Promise<void> {
        // Resolve so a chmod against a missing path still returns ENOENT
        // — that's what users expect even when the mode bits are
        // ignored.
        await this.access(path);
    }

    /**
     * `chown(path, uid, gid)` — accepted and silently ignored. Same
     * reasoning as {@link chmod}: the kv-fs inode doesn't carry uid /
     * gid yet. Returns ENOENT on a missing path so the failure mode
     * is at least correct.
     */
    public async chown(path: string, _uid: number, _gid: number): Promise<void> {
        await this.access(path);
    }

    /**
     * `flush(fh)` — POSIX `close(2)` calls this just before
     * `release(fh)`. No-op for now: every `write` on a kv-fs file
     * commits straight through to the block device, so there are no
     * buffered bytes to flush. Implemented at the `KvFilesystem` layer
     * so a future buffered-write optimization has a single hook to
     * fill in.
     */
    public async flush(fh: number): Promise<void> {
        const handle = this.requireFh(fh);
        await this.fs.getFilesystem().flush(handle.file);
    }

    /**
     * `fsync(fh, datasync)` — POSIX `fsync(2)` / `fdatasync(2)`. No-op
     * for the same reason as {@link flush}: writes are already
     * write-through. The `datasync` flag is accepted (some bindings
     * supply it) but ignored — there's no metadata-vs-data split at
     * this layer to act on.
     */
    public async fsync(fh: number, _datasync = false): Promise<void> {
        const handle = this.requireFh(fh);
        await this.fs.getFilesystem().fsync(handle.file);
    }

    /**
     * `statfs(path)` — POSIX `statfs(2)`. Returns volume-level capacity
     * info for `df` and friends. The `path` argument is part of the
     * FUSE shape but unused: the stats apply to the whole volume.
     */
    public async statfs(_path = '/'): Promise<KvFilesystemStat> {
        return await this.fs.getFilesystem().statfs();
    }

    /** Resolve `fh` to its open-file record; throws `EBADF` if unknown. */
    private requireFh(fh: number): { path: string; file: KvINodeFile } {
        const handle = this.openFiles.get(fh);
        if (!handle) {
            throw new KvFuseError('EBADF', `Unknown file handle ${fh}.`);
        }
        return handle;
    }
}
