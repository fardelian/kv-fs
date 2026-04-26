/**
 * Example: persist a kv-fs into a SQLite table and **really** mount it
 * via FUSE, then drop the user into a `zsh` session whose `$KVFS_MOUNT`
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
 * package.json — it will compile during `npm install` if the
 * OS-level FUSE library and `pkg-config` are present (macFUSE / FUSE-T
 * on macOS, libfuse on Linux) and silently skip otherwise.
 *
 * Lifecycle:
 *   1. Open SQLite, format the volume on first run.
 *   2. Mount via FUSE at `$KVFS_MOUNT` (default `/tmp/kvfs-manual`).
 *   3. Spawn `zsh` with stdio inherited and `KVFS_MOUNT` exported.
 *   4. When the shell exits — `exit` / Ctrl+D — run shutdown:
 *      `fuse.unmount → KvFilesystem.flush() → database.close() → exit 0`.
 *   5. SIGTERM from outside kills the shell, which funnels through the
 *      same shutdown path. SIGINT inside the shell stays with zsh
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

/** Total number of `[N/STEP_COUNT]` log lines this script emits. Bump when adding a step. */
const STEP_COUNT = 6;

const TABLE_NAME = 'blocks_fuse_manual';
// Resolve `data/` relative to this source file via import.meta.url —
// `__dirname` doesn't exist under Node ESM (this example runs via tsx).
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
    console.log(`[1/${STEP_COUNT}] loading @cocalc/fuse-native...`);
    let Fuse: typeof import('@cocalc/fuse-native').default;
    try {
        const mod = await import('@cocalc/fuse-native');
        Fuse = mod.default;
        console.log(`      loaded; default export typeof = ${typeof Fuse}`);
    } catch (err: unknown) {
        console.error('`@cocalc/fuse-native` did not load:', err);
        console.error('It is an optionalDependency, so `npm install` skips it silently');
        console.error('when the OS-level FUSE library or `pkg-config` is missing. To fix it:');
        console.error('  - macOS: install macFUSE (https://osxfuse.github.io/) or FUSE-T (https://www.fuse-t.org/)');
        console.error('           plus `brew install pkg-config`,');
        console.error('           then `rm -rf node_modules package-lock.json && npm install` to recompile the binding.');
        console.error('  - Linux: install libfuse-dev (Debian/Ubuntu) or fuse3-devel (Fedora) plus pkg-config,');
        console.error('           then `rm -rf node_modules package-lock.json && npm install`.');
        process.exit(1);
    }

    // ---- 1. SQLite-backed kv-fs on a fresh table ----
    console.log(`[2/${STEP_COUNT}] opening SQLite database...`);
    const database = await AsyncDatabase.open(DB_PATH);
    const blockDevice = new KvBlockDeviceSqlite3(
        BLOCK_SIZE,
        BLOCK_SIZE * TOTAL_BLOCKS,
        database,
        TABLE_NAME,
    );

    // Format only when the table is empty.
    const highest = await blockDevice.getHighestBlockId();
    const needsFormat = highest < 2;
    if (needsFormat) {
        console.log(`[3/${STEP_COUNT}] table "${TABLE_NAME}" is empty — formatting a fresh kv-fs volume.`);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
    } else {
        console.log(`[3/${STEP_COUNT}] table "${TABLE_NAME}" already populated (highest block id = ${highest}); reusing the existing volume.`);
    }

    const filesystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
    const easyFs = new KvFilesystemSimple(filesystem, '/');
    const handlers = new KvFuseHandlers(easyFs, BLOCK_SIZE);

    // Seed a freshly-formatted volume so a first-time mount lands on
    // something self-explanatory rather than an empty directory. Done
    // before mount so the seed writes go straight through the kv-fs
    // API instead of round-tripping through the FUSE kernel layer.
    if (needsFormat) {
        const enc = new TextEncoder();
        await easyFs.createFile('/README.txt');
        await easyFs.writeFile('/README.txt', enc.encode(
            'This is the kv-fs FUSE mount.\n'
            + '\n'
            + 'It is backed by a SQLite database at data/data.sqlite3 (table\n'
            + '`blocks_fuse_manual`). Every read/write you do here goes through the\n'
            + 'kv-fs handlers and is persisted in SQLite, so your changes survive\n'
            + 'across runs of `npm run start-sqlite-permanent-fuse-manual`.\n',
        ));
        await easyFs.createDirectory('/example');
        await easyFs.createFile('/example/hello.txt');
        await easyFs.writeFile('/example/hello.txt', enc.encode('hello world\n'));
        console.log('      seeded README.txt and example/hello.txt.');
    }

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
    console.log(`[4/${STEP_COUNT}] constructing Fuse(${MOUNT_POINT}, ...)...`);
    const fuse = new Fuse(MOUNT_POINT, ops, { force: true, mkdir: true });
    console.log(`[5/${STEP_COUNT}] calling fuse.mount() — this is where macFUSE / FUSE-T gets engaged...`);
    await new Promise<void>((resolve, reject) => {
        fuse.mount((err: Error | null) => {
            if (err) reject(err);
            else resolve();
        });
    });
    console.log(`[6/${STEP_COUNT}] mounted at ${MOUNT_POINT}.`);
    console.log('Spawning zsh with cwd=$KVFS_MOUNT. Try:');
    console.log('  ls -al');
    console.log('  cat README.txt');
    console.log('  cat example/hello.txt');
    console.log('  echo "hi" > greet.txt && cat greet.txt');
    console.log('  df .');
    console.log('Type `exit` (or Ctrl+D) to unmount and quit.');

    // ---- 4. Spawn `zsh` and shut down cleanly when it exits ----
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

    // Do *not* pass `cwd: MOUNT_POINT` to spawn() — on macOS that becomes
    // a `posix_spawn_file_actions_addchdir_np` and the chdir into the FUSE
    // mount happens during the spawn syscall, which sends a LOOKUP
    // request to the FUSE daemon (us) while our event loop is still
    // blocked inside posix_spawn waiting for child setup. Hard freeze
    // until the mount is torn down (then spawn fails with ENOTCONN).
    // Have zsh do the cd itself after it's running — by then our event
    // loop is free to serve the FUSE callbacks and the cd succeeds.
    const shell = spawn('zsh', ['-c', 'cd "$KVFS_MOUNT" && exec zsh'], {
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
    // Inside the shell, Ctrl+C is zsh's to handle (it just refreshes
    // the prompt). The terminal driver delivers SIGINT to both zsh and
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
 * 1) Make sure the OS-level FUSE library and `pkg-config` are
 *    installed so `npm install` can compile the `fuse-native`
 *    optionalDependency:
 *      - macOS: macFUSE (https://osxfuse.github.io/) or FUSE-T
 *        (https://www.fuse-t.org/). FUSE-T is the kext-free option
 *        and is usually the easier setup on Apple Silicon. Plus
 *        `brew install pkg-config`.
 *      - Linux: libfuse-dev (Debian/Ubuntu) or fuse3-devel (Fedora),
 *        plus pkg-config. The kernel module ships with most distros.
 *    Then `npm install`. If you'd already installed without the OS
 *    library or pkg-config, npm won't retry the optional dep on its
 *    own — wipe and reinstall:
 *        rm -rf node_modules package-lock.json && npm install
 *
 * 2) Start the example:
 *
 *        npm run start-sqlite-permanent-fuse-manual
 *
 *    The default mount point is /tmp/kvfs-manual; override with the
 *    KVFS_MOUNT environment variable if you'd rather mount elsewhere.
 *
 * 3) The example mounts and drops you into a `zsh` session whose
 *    cwd is the mount (also exported as $KVFS_MOUNT). Try:
 *
 *        ls -al
 *        cat README.txt
 *        cat example/hello.txt
 *        echo 'hello' > greet.txt
 *        echo ' world' >> greet.txt   # tests append
 *        cat greet.txt
 *        mkdir sub
 *        cp greet.txt sub/copy.txt
 *        mv sub/copy.txt copy.txt
 *        rm copy.txt
 *        rmdir sub
 *        df .
 *        touch greet.txt
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
