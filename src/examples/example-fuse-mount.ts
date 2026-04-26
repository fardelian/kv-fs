/**
 * Example: mount a KvFilesystem at a local mount point via FUSE.
 *
 * The actual FUSE binding is platform-specific and brings native
 * dependencies (kext-free `FUSE-T` on macOS, libfuse on Linux,
 * `winfsp` on Windows). This example shows the wire-up shape; install
 * one of those bindings before running it for real:
 *
 *   # Linux / macOS
 *   npm install fuse-native
 *
 *   # Windows
 *   npm install winfsp.net
 *
 * Then uncomment the import and `Fuse` block below. The handlers
 * themselves are framework-agnostic — only the callback shapes around
 * them change per binding.
 */
import { KvBlockDeviceMemory } from '../lib/block-devices';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';
import { KvFuseError, KvFuseHandlers } from '../lib/fuse';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 1024;
const TOTAL_INODES = 256;

async function buildHandlers(): Promise<KvFuseHandlers> {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
    await KvFilesystem.format(device, TOTAL_INODES);
    const fs = new KvFilesystemSimple(new KvFilesystem(device, 0), '/');
    return new KvFuseHandlers(fs, BLOCK_SIZE);
}

/** Map our friendly errno codes to whatever the binding's numeric values are. */
function errnoFor(code: string): number {
    // fuse-native exposes Fuse.ENOENT etc.; until it's installed we mock
    // the values. Replace with `Fuse.ENOENT` etc. when uncommented.
    const map: Record<string, number> = {
        ENOENT: -2,
        EEXIST: -17,
        EISDIR: -21,
        ENOTDIR: -20,
        EBADF: -9,
        ENOSYS: -38,
        EIO: -5,
    };
    return map[code] ?? -5;
}

/** Translate one of our async handlers into the (cb)-shaped FUSE method. */
function adaptAsync<R>(
    fn: () => Promise<R>,
    cb: (errno: number, result?: R) => void,
): void {
    fn().then(
        (result) => { cb(0, result); },
        (err: unknown) => {
            if (err instanceof KvFuseError) {
                cb(errnoFor(err.code));
            } else {
                cb(-5);
            }
        },
    );
}

async function main(): Promise<void> {
    const handlers = await buildHandlers();

    // ---- Wire to fuse-native (uncomment after `npm install fuse-native`) ----
    //
    // import Fuse from 'fuse-native';
    // const ops = {
    //     readdir: (path: string, cb: (errno: number, names?: string[]) => void) =>
    //         adaptAsync(() => handlers.readdir(path).then((names) => ['.', '..', ...names]), cb),
    //
    //     getattr: (path: string, cb: (errno: number, stat?: object) => void) =>
    //         adaptAsync(() => handlers.getattr(path), cb),
    //
    //     open: (path: string, _flags: number, cb: (errno: number, fh?: number) => void) =>
    //         adaptAsync(() => handlers.open(path), cb),
    //
    //     create: (path: string, _mode: number, cb: (errno: number, fh?: number) => void) =>
    //         adaptAsync(() => handlers.create(path), cb),
    //
    //     read: (path: string, fh: number, buffer: Buffer, length: number, position: number,
    //            cb: (bytesRead: number) => void) => {
    //         handlers.read(fh, length, position).then((bytes) => {
    //             buffer.set(bytes);
    //             cb(bytes.length);
    //         }, () => cb(0));
    //     },
    //
    //     write: (path: string, fh: number, buffer: Buffer, length: number, position: number,
    //             cb: (bytesWritten: number) => void) => {
    //         const data = new Uint8Array(buffer.buffer, buffer.byteOffset, length);
    //         handlers.write(fh, data, position).then(cb, () => cb(0));
    //     },
    //
    //     release: (path: string, fh: number, cb: (errno: number) => void) =>
    //         adaptAsync(() => handlers.release(fh), cb),
    //
    //     unlink: (path: string, cb: (errno: number) => void) =>
    //         adaptAsync(() => handlers.unlink(path), cb),
    //
    //     mkdir: (path: string, _mode: number, cb: (errno: number) => void) =>
    //         adaptAsync(() => handlers.mkdir(path), cb),
    //
    //     truncate: (path: string, size: number, cb: (errno: number) => void) =>
    //         adaptAsync(() => handlers.truncate(path, size), cb),
    // };
    //
    // const mountPoint = '/tmp/kvfs-mount';
    // const fuse = new Fuse(mountPoint, ops, { force: true, mkdir: true });
    // fuse.mount((err: Error | null) => {
    //     if (err) throw err;
    //     console.log(`Mounted at ${mountPoint}`);
    // });

    console.log('FUSE handlers ready; uncomment the fuse-native section above to mount.');
    // Reference adaptAsync so TypeScript doesn't trim it as unused.
    void adaptAsync;
    void handlers;
}

main().catch(console.error);
