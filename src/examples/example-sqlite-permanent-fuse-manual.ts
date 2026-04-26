/**
 * Example: persist a kv-fs into a SQLite table and **really** mount it
 * via FUSE so the host's normal fs syscalls (`ls`, `cat`, `echo >>`,
 * `cp`, `df`, `touch`, ...) work against it.
 *
 * Unlike `example-sqlite-permanent-fuse-auto.ts` (which only walks the
 * FUSE handlers in-process), this one loads the optional native binding
 * `fuse-native` and mounts at a real OS mount point. SIGINT and SIGTERM
 * are trapped so an orderly Ctrl+C: unmount → `KvFilesystem.flush()` →
 * close the SQLite database → exit. (`flush()` is a stub at the
 * filesystem layer right now; the wire-up is here so a future buffered-
 * write impl gets called on shutdown for free.)
 *
 * See the "How to test" comment at the bottom of the file for setup
 * and a quick smoke-test script.
 */
import { mkdirSync } from 'fs';
import { AsyncDatabase } from 'promised-sqlite3';
import { KvBlockDeviceSqlite3 } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvFuseError, KvFuseHandlers } from '../lib/fuse';

// The minimal type stub for `fuse-native` lives in the sibling
// `fuse-native.d.ts` so this file stays a plain module.

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

const TABLE_NAME = 'blocks_fuse_manual';
const LOCAL_FS_PATH = `${__dirname}/../../data`;
const DB_PATH = `${LOCAL_FS_PATH}/data.sqlite3`;
const MOUNT_POINT = process.env.KVFS_MOUNT ?? '/tmp/kvfs-manual';

mkdirSync(LOCAL_FS_PATH, { recursive: true });

/**
 * Map our descriptive errno names to the integer codes `fuse-native`
 * expects. Negative because FUSE uses negative errno return values to
 * signal failure; positive return is "this many bytes" for read/write.
 */
function errnoFor(code: string): number {
    const map: Record<string, number> = {
        ENOENT: -2,
        EEXIST: -17,
        EISDIR: -21,
        ENOTDIR: -20,
        ENOTEMPTY: -39,
        EBADF: -9,
        ENOSYS: -38,
        EIO: -5,
    };
    return map[code] ?? -5;
}

/** Adapt one of our async handlers into the (cb)-shaped FUSE method. */
function adaptAsync<R>(
    fn: () => Promise<R>,
    cb: (errno: number, result?: R) => void,
): void {
    fn().then(
        (result) => { cb(0, result); },
        (err: unknown) => {
            if (err instanceof KvFuseError) cb(errnoFor(err.code));
            else {
                console.error('FUSE op failed:', err);
                cb(-5);
            }
        },
    );
}

async function run(): Promise<void> {
    let Fuse: typeof import('fuse-native').default;
    try {
        Fuse = (await import('fuse-native')).default;
    } catch {
        console.error('Could not load `fuse-native`. Install it before running this example:');
        console.error('  bun add fuse-native');
        console.error('On macOS you also need macFUSE or FUSE-T; on Linux, libfuse-dev.');
        process.exit(1);
    }

    // ---- 1. SQLite-backed kv-fs on a fresh table ----
    const database = await AsyncDatabase.open(DB_PATH);
    const blockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        database,
        TABLE_NAME,
    );

    // Format only when the table is empty.
    const highest = await blockDevice.getHighestBlockId();
    if (highest === -1) {
        console.log(`Table "${TABLE_NAME}" is empty — formatting a fresh kv-fs volume.`);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
    } else {
        console.log(`Table "${TABLE_NAME}" already populated (highest block id = ${highest}); reusing the existing volume.`);
    }

    const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
    const easyFs = new KvFilesystemSimple(filesystem, '/');
    const handlers = new KvFuseHandlers(easyFs, BLOCK_SIZE);

    // ---- 2. Wire the handlers into fuse-native's vtable ----
    const ops: Record<string, unknown> = {
        readdir: (path: string, cb: (errno: number, names?: string[]) => void) => {
            adaptAsync(async () => ['.', '..', ...await handlers.readdir(path)], cb);
        },

        getattr: (path: string, cb: (errno: number, stat?: unknown) => void) => {
            adaptAsync(() => handlers.getattr(path), cb);
        },

        access: (path: string, mode: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.access(path, mode), cb);
        },

        open: (path: string, _flags: number, cb: (errno: number, fh?: number) => void) => {
            adaptAsync(() => handlers.open(path), cb);
        },

        create: (path: string, mode: number, cb: (errno: number, fh?: number) => void) => {
            adaptAsync(() => handlers.create(path, mode), cb);
        },

        read: (
            _path: string,
            fh: number,
            buffer: Buffer,
            length: number,
            position: number,
            cb: (bytesRead: number) => void,
        ) => {
            handlers.read(fh, length, position).then(
                (bytes) => {
                    buffer.set(bytes);
                    cb(bytes.length);
                },
                (err: unknown) => {
                    console.error('read failed:', err);
                    cb(0);
                },
            );
        },

        write: (
            _path: string,
            fh: number,
            buffer: Buffer,
            length: number,
            position: number,
            cb: (bytesWritten: number) => void,
        ) => {
            const data = new Uint8Array(buffer.buffer, buffer.byteOffset, length);
            handlers.write(fh, data, position).then(
                (n) => { cb(n); },
                (err: unknown) => {
                    console.error('write failed:', err);
                    cb(0);
                },
            );
        },

        flush: (_path: string, fh: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.flush(fh), cb);
        },

        fsync: (_path: string, fh: number, datasync: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.fsync(fh, datasync !== 0), cb);
        },

        release: (_path: string, fh: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.release(fh), cb);
        },

        unlink: (path: string, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.unlink(path), cb);
        },

        truncate: (path: string, size: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.truncate(path, size), cb);
        },

        mkdir: (path: string, mode: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.mkdir(path, mode), cb);
        },

        rmdir: (path: string, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.rmdir(path), cb);
        },

        rename: (from: string, to: string, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.rename(from, to), cb);
        },

        utimens: (path: string, atime: Date, mtime: Date, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.utimens(path, atime, mtime), cb);
        },

        chmod: (path: string, mode: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.chmod(path, mode), cb);
        },

        chown: (path: string, uid: number, gid: number, cb: (errno: number) => void) => {
            adaptAsync(() => handlers.chown(path, uid, gid), cb);
        },

        statfs: (path: string, cb: (errno: number, statfs?: unknown) => void) => {
            adaptAsync(() => handlers.statfs(path), cb);
        },
    };

    // ---- 3. Mount ----
    const fuse = new Fuse(MOUNT_POINT, ops, { force: true, mkdir: true });
    await new Promise<void>((resolve, reject) => {
        fuse.mount((err: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
    console.log(`Mounted at ${MOUNT_POINT}.`);
    console.log('Try (in another terminal):');
    console.log(`  ls -al ${MOUNT_POINT}`);
    console.log(`  echo 'hello' > ${MOUNT_POINT}/greet.txt`);
    console.log(`  cat ${MOUNT_POINT}/greet.txt`);
    console.log(`  echo ' world' >> ${MOUNT_POINT}/greet.txt`);
    console.log(`  df ${MOUNT_POINT}`);
    console.log('Press Ctrl+C (or send SIGTERM) to unmount cleanly.');

    // ---- 4. Trap SIGINT / SIGTERM and shut down cleanly ----
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\nReceived ${signal} — unmounting and flushing.`);
        // Order matters: unmount FIRST so the kernel stops sending FUSE
        // calls into our handlers, THEN flush filesystem state, THEN
        // close the database.
        fuse.unmount((unmountErr: Error | null) => {
            if (unmountErr) console.error('unmount error:', unmountErr);
            // Filesystem-wide flush is a no-op stub today, but the call
            // is in the shutdown path so a future buffered-write impl
            // gets a chance to drain on graceful exit.
            filesystem.flush().then(
                async () => {
                    try {
                        await database.close();
                    } catch (err) {
                        console.error('database close error:', err);
                    }
                    process.exit(0);
                },
                (err: unknown) => {
                    console.error('flush error:', err);
                    process.exit(1);
                },
            );
        });
    };

    process.on('SIGINT', () => {
        shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
        shutdown('SIGTERM');
    });
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});

/*
 * ---- How to test ---------------------------------------------------
 *
 * 1) Install the native FUSE binding (it's not in package.json — only
 *    this example needs it):
 *
 *        bun add fuse-native
 *
 *    macOS prerequisite: install macFUSE (https://osxfuse.github.io/)
 *      or FUSE-T (https://www.fuse-t.org/). FUSE-T is the kext-free
 *      option and is usually the easier setup on Apple Silicon.
 *
 *    Linux prerequisite: libfuse-dev (Debian/Ubuntu) or fuse3-devel
 *      (Fedora). The kernel module is preinstalled on most distros.
 *
 * 2) Create / clear the mount point if you've used it before:
 *
 *        mkdir -p /tmp/kvfs-manual
 *        # If a previous run was killed: `umount /tmp/kvfs-manual`
 *        # (`diskutil unmount` on macOS) before remounting.
 *
 * 3) Start the example:
 *
 *        bun run start-sqlite-permanent-fuse-manual
 *
 *    Override the mount point with the KVFS_MOUNT environment
 *    variable if `/tmp/kvfs-manual` doesn't suit you.
 *
 * 4) In another terminal, drive the volume with normal shell tools:
 *
 *        ls -al /tmp/kvfs-manual
 *        echo 'hello' > /tmp/kvfs-manual/greet.txt
 *        cat /tmp/kvfs-manual/greet.txt
 *        echo ' world' >> /tmp/kvfs-manual/greet.txt   # tests append
 *        cat /tmp/kvfs-manual/greet.txt
 *        mkdir /tmp/kvfs-manual/sub
 *        cp /tmp/kvfs-manual/greet.txt /tmp/kvfs-manual/sub/copy.txt
 *        mv /tmp/kvfs-manual/sub/copy.txt /tmp/kvfs-manual/copy.txt
 *        rm /tmp/kvfs-manual/copy.txt
 *        rmdir /tmp/kvfs-manual/sub
 *        df /tmp/kvfs-manual
 *        touch /tmp/kvfs-manual/greet.txt
 *
 *    Each of those issues a FUSE call into our handlers; the kv-fs
 *    state lives in `data/data.sqlite3` (table `blocks_fuse_manual`).
 *
 * 5) Stop the example with Ctrl+C (SIGINT) or `kill <pid>` (SIGTERM).
 *    The shutdown path: unmount → KvFilesystem.flush() →
 *    database.close() → exit 0.
 *
 *    If a crash leaves the mount point stale, force-unmount with
 *    `umount /tmp/kvfs-manual` (or `diskutil unmount` on macOS) before
 *    starting again.
 */
