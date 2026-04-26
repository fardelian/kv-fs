import { SuperBlock } from './kv-super-block';
import { INodeId, KV_INODE_KIND_DIRECTORY, KvINodeDirectory, KvINodeFile, readInodeKind } from '../inode';
import { KvBlockDevice } from '../block-devices';
import { Init, KvError_FS_Exists, KvError_FS_NotEmpty } from '../utils';

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
     * Read bytes out of `file` without touching its position cursor.
     * `start` defaults to `0`; `length` defaults to "as many bytes as
     * remain after `start`" — `KvINodeFile.readPartial` caps at EOF
     * so passing a length larger than the file yields the bytes that
     * are actually there. Reading past EOF returns an empty buffer.
     */
    @Init
    public async read(
        file: KvINodeFile,
        start = 0,
        length: number = Number.MAX_SAFE_INTEGER,
    ): Promise<Uint8Array> {
        return await file.readPartial(start, length);
    }

    /**
     * Write `data` into `file` according to `mode` (see {@link KvWriteMode}).
     * `offset` is only consulted when `mode === 'partial'` and defaults
     * to `0`.
     *
     * The file's position cursor is **not** touched — these are
     * stateless, POSIX-`pwrite`-style writes. Append mode reads
     * `file.size` and writes there; the file grows by `data.length`.
     */
    @Init
    public async write(
        file: KvINodeFile,
        data: Uint8Array,
        mode: KvWriteMode = 'truncate',
        offset = 0,
    ): Promise<void> {
        // Force the file's @Init to fire so `file.size` reflects the
        // on-disk inode before `'append'` reads it. Cheap — readPartial
        // with a zero-length range short-circuits without any block I/O.
        await file.readPartial(0, 0);

        switch (mode) {
            case 'truncate':
                await file.truncate(0);
                await file.writePartial(0, data);
                return;
            case 'append':
                await file.writePartial(file.size, data);
                return;
            case 'partial':
                await file.writePartial(offset, data);
        }
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
