import { SuperBlock } from './kv-super-block';
import { DirectoryINode } from '../inode/kv-directory-inode';
import { FileINode } from '../inode/kv-file-inode';
import { KvBlockDevice } from '../block-device/types';

export class KvFilesystem {
    private readonly blockDevice: KvBlockDevice;
    private readonly superBlock: SuperBlock;

    constructor(blockDevice: KvBlockDevice, superBlockId: number) {
        this.blockDevice = blockDevice;
        this.superBlock = new SuperBlock(blockDevice, superBlockId);
    }

    // File operations

    public createFile(name: string, directory: DirectoryINode): FileINode {
        const file = FileINode.createEmptyFile(this.blockDevice);
        directory.addEntry(name, file.id);
        return file;
    }

    public getFile(name: string, directory: DirectoryINode): FileINode {
        const inodeId = directory.getEntry(name);
        if (inodeId === undefined) {
            throw new Error(`No file with the name "${name}" exists`);
        }

        return new FileINode(this.blockDevice, inodeId);
    }

    public unlink(name: string, directory: DirectoryINode): void {
        const inodeId = directory.getEntry(name);
        if (inodeId === undefined) {
            throw new Error(`No file with the name "${name}" exists`);
        }

        directory.removeEntry(name);
        const file = new FileINode(this.blockDevice, inodeId);
        file.unlink();
    }

    // Directory operations

    public createDirectory(name: string, directory: DirectoryINode): DirectoryINode {
        const id = this.blockDevice.getNextINodeId();
        const newDirectory = DirectoryINode.createEmptyDirectory(this.blockDevice, id);
        directory.addEntry(name, newDirectory.id);

        return newDirectory;
    }

    public getDirectory(name: string, directory: DirectoryINode): DirectoryINode {
        const inodeId = directory.getEntry(name);
        if (inodeId === undefined) {
            throw new Error(`No directory with the name "${name}" exists`);
        }

        return new DirectoryINode(this.blockDevice, inodeId);
    }

    public getRootDirectory(): DirectoryINode {
        return new DirectoryINode(this.blockDevice, this.superBlock.rootDirectoryId);
    }

    // Filesystem operations

    public static format(
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalINodes: number,
        rootDirectoryId: number = 1,
        superBlockId: number = 0,
    ): KvFilesystem {
        let blockId = 0;
        while (blockDevice.existsBlock(blockId)) {
            blockDevice.freeBlock(blockId++);
        }

        SuperBlock.createSuperBlock(superBlockId, blockDevice, totalBlocks, totalINodes, rootDirectoryId);
        DirectoryINode.createEmptyDirectory(blockDevice, rootDirectoryId);

        return new KvFilesystem(blockDevice, superBlockId);
    }
}
