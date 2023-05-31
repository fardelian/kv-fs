import { BlockDevice } from './kv-block-device';
import { INode } from './kv-inode';

export class FileINode extends INode<Buffer> {
    public size: number;
    private readonly dataBlockIds: number[];

    constructor(blockDevice: BlockDevice, id: number) {
        super(blockDevice, id);

        const buffer = this.blockDevice.readBlock(this.id);

        this.size = buffer.readInt32BE(16);

        this.dataBlockIds = [];

        let sizeFromBlocks = 0;
        let i=0;
        while (sizeFromBlocks < this.size) {
            this.dataBlockIds.push(buffer.readInt32BE(20 + i * 4));
            sizeFromBlocks += this.blockDevice.blockSize;
            i++;
        }
        // for (let i = 0; i < (this.blockDevice.blockSize - 20) / 4; i++) {
        //     this.dataBlockIds.push(buffer.readInt32BE(20 + i * 4));
        // }
    }

    public read(): Buffer {
        let data = Buffer.alloc(this.size);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            const blockData = this.blockDevice.readBlock(this.dataBlockIds[i]);
            blockData.copy(data, i * this.blockDevice.blockSize);
        }

        return data;
    }

    public write(data: Buffer): void {
        const requiredBlocks = Math.ceil(data.length / this.blockDevice.blockSize);

        // If more blocks are required, allocate them

        while (this.dataBlockIds.length < requiredBlocks) {
            this.dataBlockIds.push(this.blockDevice.getNextINodeId());
        }

        // If less blocks are required, free them

        while (this.dataBlockIds.length > requiredBlocks) {
            this.blockDevice.freeBlock(this.dataBlockIds.pop()!);
        }

        // Write the data to the blocks

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            const blockData = data.subarray(i * this.blockDevice.blockSize, (i + 1) * this.blockDevice.blockSize);
            this.blockDevice.writeBlock(this.dataBlockIds[i], blockData);
        }

        // Update the metadata

        this.size = data.length;
        this.modificationTime = new Date();

        const buffer = Buffer.alloc(this.blockDevice.blockSize);
        buffer.writeBigUInt64BE(BigInt(this.creationTime.getTime()), 0);
        buffer.writeBigUInt64BE(BigInt(this.modificationTime.getTime()), 8);
        buffer.writeInt32BE(this.size, 16);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            buffer.writeInt32BE(this.dataBlockIds[i], 20 + i * 4);
        }

        this.blockDevice.writeBlock(this.id, buffer);
    }

    public unlink(): void {
        for (let i = 0; i < this.dataBlockIds.length; i++) {
            this.blockDevice.freeBlock(this.dataBlockIds[i]);
        }

        this.blockDevice.freeBlock(this.id);

        this.size = 0;
        this.modificationTime = new Date();
    }

    public static createEmptyFile(blockDevice: BlockDevice): FileINode {
        const id = blockDevice.getNextINodeId();
        const creationTime = new Date();
        const modificationTime = new Date();

        const buffer = Buffer.alloc(blockDevice.blockSize);
        buffer.writeBigUInt64BE(BigInt(creationTime.getTime()), 0);
        buffer.writeBigUInt64BE(BigInt(modificationTime.getTime()), 8);
        buffer.writeInt32BE(0, 16);

        for (let i = 0; i < (blockDevice.blockSize - 20) / 4; i++) {
            buffer.writeInt32BE(0, 20 + i * 4);
        }

        blockDevice.writeBlock(id, buffer);

        return new FileINode(blockDevice, id);
    }
}
