/**
 * Example: persist a kv-fs into a SQLite table and **really** mount it
 * via FUSE, then drop the user into a `bash` session whose `$KVFS_MOUNT`
 * points at the mount. The host's normal fs syscalls (`ls`, `cat`,
 * `echo >>`, `cp`, `df`, `touch`, ...) all flow through the kernel
 * into our handlers.
 *
 * Unlike `example-sqlite-permanent-fuse-auto.ts` (which only walks the
 * FUSE handlers in-process), this one loads `@cocalc/fuse-native` and
 * mounts at a real OS mount point. We use the cocalc fork rather than
 * the original `fuse-native` (which has been unmaintained since 2021):
 * the fork is rebuilt against modern macFUSE / FUSE-T / libfuse so
 * `mount()` doesn't segfault on recent macOS / Linux releases. Same
 * API on both.
 *
 * The native binding is declared as an `optionalDependency` in
 * package.json — it will compile during `bun install` if the
 * OS-level FUSE library is present (macFUSE / FUSE-T on macOS,
 * libfuse on Linux) and silently skip otherwise.
 *
 * Lifecycle:
 *   1. Open SQLite, format the volume on first run.
 *   2. Mount via FUSE at `$KVFS_MOUNT` (default `/tmp/kvfs-manual`).
 *   3. Spawn `bash` with stdio inherited and `KVFS_MOUNT` exported.
 *   4. When the shell exits — `exit` / Ctrl+D — run shutdown:
 *      `fuse.unmount → KvFilesystem.flush() → database.close() → exit 0`.
 *   5. SIGTERM from outside kills the shell, which funnels through the
 *      same shutdown path. SIGINT inside the shell stays with bash
 *      (Ctrl+C just refreshes its prompt).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncDatabase } from 'promised-sqlite3';
import { KvBlockDeviceSqlite3 } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvFuseError, KvFuseHandlers } from '../lib/fuse';

// The minimal type stub for `@cocalc/fuse-native` lives in the
// sibling `cocalc-fuse-native.d.ts` so this file stays a plain module.

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1000;
const TOTAL_INODES = 100;
const SUPER_BLOCK_ID = 0;

const TABLE_NAME = 'blocks_fuse_manual';
// Resolve `data/` relative to this source file via import.meta.url —
// `__dirname` doesn't exist under tsx/Node ESM. (This example runs
// under tsx instead of bun because Bun's NAPI loader currently
// segfaults on fuse-native; see README "Mounting via FUSE".)
const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_FS_PATH = resolve(HERE, '..', '..', 'data');
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
    console.log('[1/6] loading @cocalc/fuse-native...');
    let Fuse: typeof import('@cocalc/fuse-native').default;
    try {
        const mod = await import('@cocalc/fuse-native');
        Fuse = mod.default;
        console.log(`      loaded; default export typeof = ${typeof Fuse}`);
    } catch (err: unknown) {
        console.error('`@cocalc/fuse-native` did not load:', err);
        console.error('It is an optionalDependency, so `bun install` skips it silently');
        console.error('when the OS-level FUSE library is missing. To fix it:');
        console.error('  - macOS: install macFUSE (https://osxfuse.github.io/) or FUSE-T (https://www.fuse-t.org/),');
        console.error('           then re-run `bun install --force` to recompile the binding.');
        console.error('  - Linux: install libfuse-dev (Debian/Ubuntu) or fuse3-devel (Fedora),');
        console.error('           then re-run `bun install --force`.');
        process.exit(1);
    }

    // ---- 1. SQLite-backed kv-fs on a fresh table ----
    console.log('[2/6] opening SQLite database...');
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
        console.log(`[3/6] table "${TABLE_NAME}" is empty — formatting a fresh kv-fs volume.`);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
    } else {
        console.log(`[3/6] table "${TABLE_NAME}" already populated (highest block id = ${highest}); reusing the existing volume.`);
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
    console.log(`[4/6] constructing Fuse(${MOUNT_POINT}, ...)...`);
    const fuse = new Fuse(MOUNT_POINT, ops, { force: true, mkdir: true });
    console.log('[5/6] calling fuse.mount() — this is where macFUSE / FUSE-T gets engaged...');
    await new Promise<void>((resolve, reject) => {
        fuse.mount((err: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
    console.log(`[6/6] mounted at ${MOUNT_POINT}.`);
    console.log('Spawning bash. The mount point is exported as $KVFS_MOUNT inside the shell.');
    console.log('Try:');
    console.log('  ls -al "$KVFS_MOUNT"');
    console.log('  echo "hello" > "$KVFS_MOUNT/greet.txt"');
    console.log('  cat "$KVFS_MOUNT/greet.txt"');
    console.log('  echo " world" >> "$KVFS_MOUNT/greet.txt"');
    console.log('  df "$KVFS_MOUNT"');
    console.log('Type `exit` (or Ctrl+D) to unmount and quit.');

    // ---- 4. Spawn `bash` and shut down cleanly when it exits ----
    let shuttingDown = false;
    const shutdown = (reason: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`Shutting down (${reason}); unmounting and flushing.`);
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

    const shell = spawn('bash', [], {
        stdio: 'inherit',
        env: { ...process.env, KVFS_MOUNT: MOUNT_POINT },
    });

    shell.on('exit', (code, signal) => {
        const reason = signal !== null ? `shell exited via ${signal}` : `shell exited with code ${code ?? 'null'}`;
        shutdown(reason);
    });

    // Outside-the-shell SIGTERM (e.g. `kill <pid>`) tears down the
    // shell, which then triggers the same shutdown path via shell.on('exit').
    process.on('SIGTERM', () => {
        if (!shell.killed) shell.kill('SIGTERM');
        else shutdown('SIGTERM');
    });
    // Inside the shell, Ctrl+C is bash's to handle (it just refreshes
    // the prompt). The terminal driver delivers SIGINT to both bash and
    // us; ignoring it here keeps the shell session alive — the user
    // ends the session with `exit` instead.
    process.on('SIGINT', () => {
        // intentional no-op while the shell owns the foreground tty.
    });
}

run().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});

/*
 * ---- How to test ---------------------------------------------------
 *
 * 1) Make sure the OS-level FUSE library is installed so `bun install`
 *    can compile the `fuse-native` optionalDependency:
 *      - macOS: macFUSE (https://osxfuse.github.io/) or FUSE-T
 *        (https://www.fuse-t.org/). FUSE-T is the kext-free option
 *        and is usually the easier setup on Apple Silicon.
 *      - Linux: libfuse-dev (Debian/Ubuntu) or fuse3-devel (Fedora).
 *        The kernel module ships with most distros.
 *    Then `bun install` (re-run if you'd already installed without
 *    the OS library — bun will skip optionalDependencies that fail
 *    to compile and won't retry unless you force it).
 *
 * 2) Start the example:
 *
 *        bun run start-sqlite-permanent-fuse-manual
 *
 *    The default mount point is /tmp/kvfs-manual; override with the
 *    KVFS_MOUNT environment variable if you'd rather mount elsewhere.
 *
 * 3) The example mounts and drops you into a `bash` session with
 *    $KVFS_MOUNT pointing at the mount. From inside the shell:
 *
 *        ls -al "$KVFS_MOUNT"
 *        echo 'hello' > "$KVFS_MOUNT/greet.txt"
 *        cat "$KVFS_MOUNT/greet.txt"
 *        echo ' world' >> "$KVFS_MOUNT/greet.txt"   # tests append
 *        cat "$KVFS_MOUNT/greet.txt"
 *        mkdir "$KVFS_MOUNT/sub"
 *        cp "$KVFS_MOUNT/greet.txt" "$KVFS_MOUNT/sub/copy.txt"
 *        mv "$KVFS_MOUNT/sub/copy.txt" "$KVFS_MOUNT/copy.txt"
 *        rm "$KVFS_MOUNT/copy.txt"
 *        rmdir "$KVFS_MOUNT/sub"
 *        df "$KVFS_MOUNT"
 *        touch "$KVFS_MOUNT/greet.txt"
 *
 *    Each of those issues a FUSE call into our handlers; the kv-fs
 *    state lives in `data/data.sqlite3` (table `blocks_fuse_manual`)
 *    and persists across runs.
 *
 * 4) Type `exit` (or Ctrl+D) to leave the shell. The example then
 *    runs the shutdown path: unmount → KvFilesystem.flush() →
 *    database.close() → exit 0. Sending SIGTERM from outside has
 *    the same effect (kills the shell, which funnels through
 *    shell.on('exit')).
 *
 *    If a crash leaves the mount point stale, force-unmount with
 *    `umount /tmp/kvfs-manual` (Linux) or `diskutil unmount
 *    /tmp/kvfs-manual` (macOS) before starting again.
 */
