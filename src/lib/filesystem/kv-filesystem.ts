import { SuperBlock } from './kv-super-block';
import { INodeId, KvINodeDirectory, KvINodeFile } from '../inode';
import { KvBlockDevice } from '../block-devices';
import { Init } from '../utils/init';
import { KvError_FS_NotFound } from '../utils/errors';

export class KvFilesystem {
    private blockDevice: KvBlockDevice;
    private superBlock!: SuperBlock;
    private superBlockId: INodeId;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    public async init(): Promise<void> {
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
    public async getFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        return new KvINodeFile(this.blockDevice, iNodeId);
    }

    @Init
    public async unlink(name: string, directory: KvINodeDirectory): Promise<void> {
        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        await directory.removeEntry(name);
        const file = new KvINodeFile(this.blockDevice, iNodeId);
        await file.unlink();
    }

    // Directory operations

    @Init
    public async createDirectory(name: string, directory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const id = await this.blockDevice.getNextINodeId();
        const newDirectory = await KvINodeDirectory.createEmptyDirectory(this.blockDevice, id);
        await directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    @Init
    public async getDirectory(name: string, parentDirectory: KvINodeDirectory): Promise<KvINodeDirectory> {
        const iNodeId = await parentDirectory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`Directory with the name "${name}" does not exist in given INode.`);
        }

        return new KvINodeDirectory(this.blockDevice, iNodeId);
    }

    @Init
    public async getRootDirectory(): Promise<KvINodeDirectory> {
        return new KvINodeDirectory(this.blockDevice, this.superBlock.rootDirectoryId);
    }

    // Filesystem operations

    public static async format(
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalINodes: number,
        rootDirectoryId: INodeId = 1,
        superBlockId: INodeId = 0,
    ): Promise<KvFilesystem> {
        let blockId = 0;
        while (await blockDevice.existsBlock(blockId)) {
            await blockDevice.freeBlock(blockId++);
        }

        await SuperBlock.createSuperBlock(superBlockId, blockDevice, totalBlocks, totalINodes, rootDirectoryId);
        await KvINodeDirectory.createEmptyDirectory(blockDevice, rootDirectoryId);

        // TODO Return blockDevice and superBlockId instead of filesystem!
        // The user of format() should initialize their own filesystem

        return new KvFilesystem(blockDevice, superBlockId);
    }
}
