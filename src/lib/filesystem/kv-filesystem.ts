import { SuperBlock } from './kv-super-block';
import { INodeId, KvINodeDirectory, KvINodeFile } from '../inode';
import { KvBlockDevice } from '../block-devices';
import { Init } from '../utils';

export class KvFilesystem {
    private blockDevice: KvBlockDevice;
    private superBlock!: SuperBlock;
    private superBlockId: INodeId;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    async init(): Promise<void> {
        this.superBlock = new SuperBlock(this.blockDevice, this.superBlockId);
        await this.superBlock.init();
    }

    // File operations

    @Init
    public async createFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        const file = await KvINodeFile.createEmptyFile(this.blockDevice);
        await directory.addEntry(name, file.id);
        return file;
    }

    @Init
    public async getKvFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        // getEntry throws KvError_FS_NotFound when the entry is missing,
        // which is exactly what we want callers to see.
        const iNodeId = await directory.getEntry(name);
        return new KvINodeFile(this.blockDevice, iNodeId);
    }

    @Init
    public async unlink(name: string, directory: KvINodeDirectory): Promise<void> {
        const iNodeId = await directory.getEntry(name);

        await directory.removeEntry(name);
        const file = new KvINodeFile(this.blockDevice, iNodeId);
        await file.unlink();
    }

    // Directory operations

    @Init
    public async createDirectory(name: string, directory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const id = await this.blockDevice.allocateBlock();
        const newDirectory = await KvINodeDirectory.createEmptyDirectory(this.blockDevice, id);
        await directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    @Init
    public async getDirectory(name: string, parentDirectory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const iNodeId = await parentDirectory.getEntry(name);
        return new KvINodeDirectory(this.blockDevice, iNodeId);
    }

    @Init
    public async getRootDirectory(): Promise<KvINodeDirectory> {
        return new KvINodeDirectory(this.blockDevice, this.superBlock.rootDirectoryId);
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
