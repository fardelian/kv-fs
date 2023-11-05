import { SuperBlock } from './kv-super-block';
import { DirectoryINode } from '../inode/kv-directory-inode';
import { FileINode } from '../inode/kv-file-inode';
import { KvBlockDevice } from '../block-device/types';
import { INodeId } from '../inode/kv-inode';
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

    public async createFile(name: string, directory: DirectoryINode): Promise<FileINode> {
        this.ensureInit();

        const file = await FileINode.createEmptyFile(this.blockDevice);
        await directory.addEntry(name, file.id);
        return file;
    }

    public async getFile(name: string, directory: DirectoryINode): Promise<FileINode> {
        this.ensureInit();

        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        const fileINode = new FileINode(this.blockDevice, iNodeId);
        return await fileINode.init();
    }

    public async unlink(name: string, directory: DirectoryINode): Promise<void> {
        this.ensureInit();

        const iNodeId = await directory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`File with the name "${name}" does not exist in given INode.`);
        }

        await directory.removeEntry(name);
        const file = new FileINode(this.blockDevice, iNodeId);
        await file.init();
        await file.unlink();
    }

    // Directory operations

    public async createDirectory(name: string, directory: DirectoryINode): Promise<DirectoryINode> {
        this.ensureInit();

        const id = await this.blockDevice.getNextINodeId();
        const newDirectory = await DirectoryINode.createEmptyDirectory(this.blockDevice, id);
        await directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    public async getDirectory(name: string, parentDirectory: DirectoryINode): Promise<DirectoryINode> {
        this.ensureInit();

        const iNodeId = await parentDirectory.getEntry(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`Directory with the name "${name}" does not exist in given INode.`);
        }

        const directory = new DirectoryINode(this.blockDevice, iNodeId);
        return await directory.init();
    }

    public async getRootDirectory(): Promise<DirectoryINode> {
        this.ensureInit();

        const directory = new DirectoryINode(this.blockDevice, this.superBlock.rootDirectoryId);
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
        await DirectoryINode.createEmptyDirectory(blockDevice, rootDirectoryId);

        // TODO Return blockDevice and superBlockId instead of filesystem!
        // The user of format() should initialize their own filesystem

        const fs = new KvFilesystem(blockDevice, superBlockId);
        return await fs.init();
    }
}
