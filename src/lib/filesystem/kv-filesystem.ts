import { SuperBlock } from './kv-super-block';
import { INodeId, KvINodeDirectory, KvINodeFile } from '../inode';
import { KvBlockDevice } from '../block-devices';
import { Init, KvError_FS_Exists, KvError_FS_NotEmpty } from '../utils';

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

    /** Remove a file from `directory` and free all of its data blocks. */
    @Init
    public async unlink(name: string, directory: KvINodeDirectory): Promise<void> {
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
     * Remove an empty subdirectory from `parent`. Throws
     * `KvError_FS_NotEmpty` if the directory still contains entries —
     * caller must clear it first (POSIX `rmdir` semantics).
     */
    @Init
    public async removeDirectory(name: string, parent: KvINodeDirectory): Promise<void> {
        const inodeId = await parent.getEntry(name);
        const dir = new KvINodeDirectory(this.blockDevice, inodeId);
        const entries = await dir.read();
        if (entries.size > 0) {
            throw new KvError_FS_NotEmpty(`Directory "${name}" is not empty (${entries.size} entries).`);
        }
        await dir.unlink();
        await parent.removeEntry(name);
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
