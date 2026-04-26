import { SuperBlock } from '../kv-super-block/kv-super-block';
import { INodeId, KV_INODE_KIND_DIRECTORY, KvINodeDirectory, KvINodeFile, readInodeKind } from '../../inode';
import { KvBlockDevice } from '../../block-devices';
import { Init, KvError_FS_Exists, KvError_FS_NotEmpty } from '../../utils';

/**
 * How a `KvFilesystem.write` call lays bytes onto a file. Inspired by
 * the relevant POSIX `open(2)` flags, just enough to cover the cases
 * a content-aware caller actually needs:
 *
 * - `'truncate'` (default) — `O_WRONLY | O_TRUNC`. Clears the file to
 *   zero bytes, then writes `data` starting at offset 0.
 * - `'append'` — `O_WRONLY | O_APPEND`. Writes `data` at the current
 *   end-of-file, growing the file by `data.length` bytes. The
 *   `offset` argument is ignored.
 * - `'partial'` — `O_WRONLY` with `pwrite`. Splices `data` in at the
 *   given `offset`, preserving bytes outside `[offset, offset +
 *   data.length)`. Extends the file (zero-filling the gap) when the
 *   write spills past EOF.
 */
export type KvWriteMode = 'truncate' | 'append' | 'partial';

/**
 * Volume-level statistics, the shape callers want for `df` /
 * `statfs(2)` / `fs.statSync` against a FUSE mount. Sizes are reported
 * in blocks of {@link blockSize} bytes; multiply to get bytes.
 *
 * `usedBlocks` is computed as `highestBlockId + 1` (the conservative
 * upper bound — the actual count is between the chain length and the
 * high-water mark depending on backend free-list behaviour).
 */
export interface KvFilesystemStat {
    blockSize: number;
    totalBlocks: number;
    usedBlocks: number;
    freeBlocks: number;
}

/**
 * Core filesystem: walks the superblock + inode tree on top of any
 * `KvBlockDevice`. Operations take an explicit parent directory; for
 * the path-walking facade see `KvFilesystemSimple`.
 */
export class KvFilesystem {
    private blockDevice: KvBlockDevice;
    private superBlock!: SuperBlock;
    private superBlockId: INodeId;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    /** Load the superblock; called automatically by every decorated method. */
    async init(): Promise<void> {
        this.superBlock = new SuperBlock(this.blockDevice, this.superBlockId);
        await this.superBlock.init();
    }

    // File operations

    /** Create an empty file under `directory`. */
    @Init
    public async createFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        const file = await KvINodeFile.createEmptyFile(this.blockDevice);
        await directory.addEntry(name, file.id);
        return file;
    }

    /** Open an existing file by name under `directory`. Throws `KvError_FS_NotFound` if missing. */
    @Init
    public async getKvFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        const iNodeId = await directory.getEntry(name);
        return new KvINodeFile(this.blockDevice, iNodeId);
    }

    /**
     * Read bytes out of `file`, **advancing the file's position cursor**
     * by the number of bytes returned (POSIX `read(2)` shape, not
     * `pread`).
     *
     * - `start` is optional. When provided, the cursor is moved there
     *   first (capped at EOF — reads never extend the file). When
     *   omitted, the read continues from wherever the cursor currently
     *   sits, which is what a sequential reader (or a FUSE binding
     *   doing offset-explicit calls) wants.
     * - `length` is optional. When omitted, reads to EOF.
     *
     * Reading past EOF returns an empty buffer; the cursor lands at
     * EOF in that case.
     */
    @Init
    public async read(
        file: KvINodeFile,
        start?: number,
        length?: number,
    ): Promise<Uint8Array> {
        // Force the file's @Init to fire so `file.size` reflects the
        // on-disk inode before we possibly seek relative to it. Cheap —
        // readPartial with a zero-length range short-circuits without
        // any block I/O.
        await file.readPartial(0, 0);
        if (start !== undefined) {
            // Cap at EOF so seeking past it stays read-only.
            // setPos(file.size) is fine; setPos(>file.size) would
            // extend the file with zero-fill, which is `pwrite`
            // behaviour and wrong for a read.
            await file.setPos(Math.min(start, file.size));
        }
        return await file.read(length);
    }

    /**
     * Write `data` into `file` according to `mode`
     * (see {@link KvWriteMode}). The cursor is **moved before the
     * write and advanced by `data.length`** — so subsequent reads /
     * writes pick up where this call left off (POSIX `write(2)` shape,
     * not `pwrite`).
     *
     * - `'truncate'` (default) — clears the file, writes from offset 0;
     *   cursor lands at `data.length`.
     * - `'append'` — seeks to `file.size`, then writes; cursor lands at
     *   the new EOF.
     * - `'partial'` — seeks to `offset` (default 0), then writes; cursor
     *   lands at `offset + data.length`. If `offset > file.size` the
     *   gap is zero-filled (matches POSIX `pwrite` past-EOF semantics).
     */
    @Init
    public async write(
        file: KvINodeFile,
        data: Uint8Array,
        mode: KvWriteMode = 'truncate',
        offset = 0,
    ): Promise<void> {
        // Force @Init so `file.size` is current before 'append' reads it.
        await file.readPartial(0, 0);

        switch (mode) {
            case 'truncate':
                // truncate(0) doesn't reset the cursor — explicitly seek
                // to 0 so the subsequent write lands at the start.
                await file.truncate(0);
                await file.setPos(0);
                break;
            case 'append':
                await file.setPos(file.size);
                break;
            case 'partial':
                await file.setPos(offset);
                break;
        }
        await file.write(data);
    }

    /**
     * Flush buffered file state to the backing block device. Stub for
     * now — every `write` / `writePartial` already commits straight
     * through to the block device, so there's nothing to flush, but
     * FUSE bindings call this on every `close(2)` and expect a method
     * here. Kept on `KvFilesystem` so the future case where we *do*
     * buffer (per-file dirty-page cache, batched journal flush, etc.)
     * has a single hook to fill in.
     *
     * `file` is optional: pass it for per-file flushes (FUSE flush
     * callback), omit it for filesystem-wide flushes (clean-shutdown
     * path: SIGTERM handler etc.). Stub semantics are the same in both
     * shapes today.
     */
    @Init
    public async flush(_file?: KvINodeFile): Promise<void> {
        // No-op: writes are write-through.
    }

    /**
     * Force previously-written data to durable storage. Stub — the
     * block device contract doesn't currently surface a `sync`
     * primitive, so nothing further is forced beyond what `writeBlock`
     * already did. Hook for future durability work.
     *
     * `file` is optional, mirroring {@link flush}: per-file for FUSE
     * `fsync`, omitted for a filesystem-wide sync.
     */
    @Init
    public async fsync(_file?: KvINodeFile): Promise<void> {
        // No-op: writes are write-through; no durability boundary exposed yet.
    }

    /**
     * Update an inode's modification time. Mirrors the mtime half of
     * POSIX `utimens(2)`. The kv-fs inode header doesn't carry an
     * atime, so callers that supply one should expect it to be
     * ignored; this method only persists `modificationTime`.
     */
    @Init
    public async touch(
        inode: KvINodeFile | KvINodeDirectory,
        modificationTime: Date,
    ): Promise<void> {
        await inode.touch(modificationTime);
    }

    /**
     * Volume-level stat info. `df` / `statfs(2)` shape: total /
     * used / free blocks, plus the block size to multiply by. Read
     * live from the block device — never cache.
     */
    @Init
    public async statfs(): Promise<KvFilesystemStat> {
        const blockSize = this.blockDevice.getBlockSize();
        const totalBlocks = this.blockDevice.getCapacityBlocks();
        const highest = await this.blockDevice.getHighestBlockId();
        const usedBlocks = Math.max(0, highest + 1);
        const freeBlocks = Math.max(0, totalBlocks - usedBlocks);
        return { blockSize, totalBlocks, usedBlocks, freeBlocks };
    }

    /** Remove a file from `directory` and free all of its data blocks. */
    @Init
    public async removeFile(name: string, directory: KvINodeDirectory): Promise<void> {
        const iNodeId = await directory.getEntry(name);

        await directory.removeEntry(name);
        const file = new KvINodeFile(this.blockDevice, iNodeId);
        await file.unlink();
    }

    // Directory operations

    /** Create an empty subdirectory under `directory`. */
    @Init
    public async createDirectory(name: string, directory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const id = await this.blockDevice.allocateBlock();
        const newDirectory = await KvINodeDirectory.createEmptyDirectory(this.blockDevice, id);
        await directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    /** Open an existing subdirectory by name under `parentDirectory`. */
    @Init
    public async getDirectory(name: string, parentDirectory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const iNodeId = await parentDirectory.getEntry(name);
        return new KvINodeDirectory(this.blockDevice, iNodeId);
    }

    /** Open the filesystem root directory (whose ID is recorded in the superblock). */
    @Init
    public async getRootDirectory(): Promise<KvINodeDirectory> {
        return new KvINodeDirectory(this.blockDevice, this.superBlock.rootDirectoryId);
    }

    /**
     * Remove a subdirectory from `parent`.
     *
     * - `recursive: false` (default): mirrors POSIX `rmdir` — throws
     *   `KvError_FS_NotEmpty` if the directory still contains entries.
     * - `recursive: true`: walks the subtree, freeing every file and
     *   subdirectory before unlinking the target itself (akin to
     *   `rm -r`).
     */
    @Init
    public async removeDirectory(
        name: string,
        parent: KvINodeDirectory,
        recursive = false,
    ): Promise<void> {
        const inodeId = await parent.getEntry(name);
        const dir = new KvINodeDirectory(this.blockDevice, inodeId);
        const entries = await dir.read();
        if (entries.size > 0) {
            if (!recursive) {
                throw new KvError_FS_NotEmpty(`Directory "${name}" is not empty (${entries.size} entries).`);
            }
            await this.removeChildren(dir);
        }
        await dir.unlink();
        await parent.removeEntry(name);
    }

    /**
     * Free every entry under `dir` (depth-first), then leave `dir`
     * itself empty for the caller to unlink. Used by the recursive
     * branch of `removeDirectory`.
     */
    private async removeChildren(dir: KvINodeDirectory): Promise<void> {
        const entries = await dir.read();
        for (const childId of entries.values()) {
            const kind = await readInodeKind(this.blockDevice, childId);
            if (kind === KV_INODE_KIND_DIRECTORY) {
                const childDir = new KvINodeDirectory(this.blockDevice, childId);
                await this.removeChildren(childDir);
                await childDir.unlink();
            } else {
                const file = new KvINodeFile(this.blockDevice, childId);
                await file.unlink();
            }
        }
    }

    /**
     * Move (or rename) an entry from `(oldParent, oldName)` to
     * `(newParent, newName)`. Works for both files and directories
     * since the inode itself doesn't move — only the directory entry
     * pointing at it. Throws `KvError_FS_Exists` if the destination
     * already exists; caller can `unlink` / `removeDirectory` first.
     *
     * Same-parent same-name is a no-op.
     */
    @Init
    public async rename(
        oldName: string,
        oldParent: KvINodeDirectory,
        newName: string,
        newParent: KvINodeDirectory,
    ): Promise<void> {
        // Same-parent rename: the two `KvINodeDirectory` instances may be
        // distinct objects pointing at the same inode block (typical for
        // path-walking callers), and each carries its own in-memory entries
        // cache. Routing both ops through a single instance avoids the
        // second write overwriting the first.
        if (oldParent.id === newParent.id) {
            if (oldName === newName) return;
            const inodeId = await oldParent.getEntry(oldName);
            if (await oldParent.hasEntry(newName)) {
                throw new KvError_FS_Exists(`Rename target "${newName}" already exists.`);
            }
            await oldParent.addEntry(newName, inodeId);
            await oldParent.removeEntry(oldName);
            return;
        }

        const inodeId = await oldParent.getEntry(oldName);
        if (await newParent.hasEntry(newName)) {
            throw new KvError_FS_Exists(`Rename target "${newName}" already exists.`);
        }
        // Add to the destination first; if that fails the source is
        // untouched. The brief window where the entry exists in two
        // directories is fine for a non-concurrent caller.
        await newParent.addEntry(newName, inodeId);
        await oldParent.removeEntry(oldName);
    }

    // Filesystem operations

    public static async format(
        blockDevice: KvBlockDevice,
        totalINodes: number,
        rootDirectoryId: INodeId = 1,
        superBlockId: INodeId = 0,
    ): Promise<KvFilesystem> {
        // The filesystem must fit on the device. The superblock + at
        // least one inode block must be addressable, otherwise the
        // format would silently corrupt itself.
        const capacityBlocks = blockDevice.getCapacityBlocks();
        if (totalINodes < 1 || totalINodes > capacityBlocks) {
            throw new RangeError(
                `totalINodes "${totalINodes}" must be in 1..capacityBlocks "${capacityBlocks}".`,
            );
        }

        await blockDevice.format();

        await SuperBlock.createSuperBlock(superBlockId, blockDevice, totalINodes, rootDirectoryId);
        await KvINodeDirectory.createEmptyDirectory(blockDevice, rootDirectoryId);

        // TODO Return blockDevice and superBlockId instead of filesystem!
        // The user of format() should initialize their own filesystem

        return new KvFilesystem(blockDevice, superBlockId);
    }
}
