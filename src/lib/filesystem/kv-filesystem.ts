import { SuperBlock } from './kv-super-block';
import { INodeId, KvINodeDirectory, KvINodeFile } from '../inode';
import { KvBlockDevice } from '../block-devices';
import { Init, KvError_FS_NotFound } from '../types';

export class KvFilesystem extends Init {
    private blockDevice: KvBlockDevice;
    private superBlock!: SuperBlock;
    private superBlockId: INodeId;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        super();
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    public async init(): Promise<this> {
        await super.init();

        this.superBlock = new SuperBlock(this.blockDevice, this.superBlockId);
        await this.superBlock.init();

        return this;
    }

    // File operations

    public async createFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        this.ensureInit();

        const file = await KvINodeFile.createEmptyFile(this.blockDevice);
        await directory.addEntry(name, file.id);
        return file;
    }

    public async getFile(name: string, directory: KvINodeDirectory): Promise<KvINodeFile> {
        this.ensureInit();

        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        const fileINode = new KvINodeFile(this.blockDevice, iNodeId);
        return await fileINode.init();
    }

    public async unlink(name: string, directory: KvINodeDirectory): Promise<void> {
        this.ensureInit();

        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        await directory.removeEntry(name);
        const file = new KvINodeFile(this.blockDevice, iNodeId);
        await file.init();
        await file.unlink();
    }

    // Directory operations

    public async createDirectory(name: string, directory: KvINodeDirectory): Promise<KvINodeDirectory> {
        this.ensureInit();

        const id = await this.blockDevice.getNextINodeId();
        const newDirectory = await KvINodeDirectory.createEmptyDirectory(this.blockDevice, id);
        await directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    public async getDirectory(name: string, parentDirectory: KvINodeDirectory): Promise<KvINodeDirectory> {
        this.ensureInit();

        const iNodeId = await parentDirectory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`Directory with the name "${name}" does not exist in given INode.`);
        }

        const directory = new KvINodeDirectory(this.blockDevice, iNodeId);
        return await directory.init();
    }

    public async getRootDirectory(): Promise<KvINodeDirectory> {
        this.ensureInit();

        const directory = new KvINodeDirectory(this.blockDevice, this.superBlock.rootDirectoryId);
        return await directory.init();
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

        const fs = new KvFilesystem(blockDevice, superBlockId);
        return await fs.init();
    }
}
