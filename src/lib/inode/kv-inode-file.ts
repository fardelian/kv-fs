import { INode, INodeId } from './kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init } from '../utils/init';

export class KvINodeFile extends INode<Buffer> {
    public size: number = 0;

    private dataBlockIds: INodeId[] = [];

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        super(blockDevice, id);
    }

    public async init(): Promise<void> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.id);

        this.size = buffer.readInt32BE(16);

        this.dataBlockIds = [];

        let sizeFromBlocks = 0;
        let i = 0;
        while (sizeFromBlocks < this.size) {
            this.dataBlockIds.push(buffer.readInt32BE(20 + i * 4));
            sizeFromBlocks += this.blockDevice.getBlockSize();
            i++;
        }
    }

    @Init
    public async read(): Promise<Buffer> {
        let data = Buffer.alloc(this.size);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            const blockData = await this.blockDevice.readBlock(this.dataBlockIds[i]);
            blockData.copy(data, i * this.blockDevice.getBlockSize());
        }

        return data;
    }

    @Init
    public async write(data: Buffer): Promise<void> {
        const requiredBlocks = Math.ceil(data.length / this.blockDevice.getBlockSize());

        // If more blocks are required, allocate them

        while (this.dataBlockIds.length < requiredBlocks) {
            this.dataBlockIds.push(await this.blockDevice.allocateBlock());
        }

        // If less blocks are required, free them

        while (this.dataBlockIds.length > requiredBlocks) {
            await this.blockDevice.freeBlock(this.dataBlockIds.pop()!);
        }

        // Write the data to the blocks

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            // TODO Allocate exactly the required size for the last block so the BlockDevice doesn't have to do it
            const blockData = data.subarray(i * this.blockDevice.getBlockSize(), (i + 1) * this.blockDevice.getBlockSize());
            await this.blockDevice.writeBlock(this.dataBlockIds[i], blockData);
        }

        // Update the metadata

        this.size = data.length;
        this.modificationTime = new Date();

        const buffer = Buffer.alloc(this.blockDevice.getBlockSize());
        buffer.writeBigUInt64BE(BigInt(this.creationTime.getTime()), 0);
        buffer.writeBigUInt64BE(BigInt(this.modificationTime.getTime()), 8);
        buffer.writeInt32BE(this.size, 16);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            buffer.writeInt32BE(this.dataBlockIds[i], 20 + i * 4);
        }

        await this.blockDevice.writeBlock(this.id, buffer);
    }

    @Init
    public async unlink(): Promise<void> {
        for (let i = 0; i < this.dataBlockIds.length; i++) {
            await this.blockDevice.freeBlock(this.dataBlockIds[i]);
        }

        await this.blockDevice.freeBlock(this.id);

        this.size = 0;
        this.modificationTime = new Date();
    }

    public static async createEmptyFile(blockDevice: KvBlockDevice): Promise<KvINodeFile> {
        const id = await blockDevice.allocateBlock();
        const creationTime = new Date();
        const modificationTime = new Date();

        const buffer = Buffer.alloc(blockDevice.getBlockSize());
        buffer.writeBigUInt64BE(BigInt(creationTime.getTime()), 0);
        buffer.writeBigUInt64BE(BigInt(modificationTime.getTime()), 8);
        buffer.writeInt32BE(0, 16);

        for (let i = 0; i < (blockDevice.getBlockSize() - 20) / 4; i++) {
            buffer.writeInt32BE(0, 20 + i * 4);
        }

        await blockDevice.writeBlock(id, buffer);

        return new KvINodeFile(blockDevice, id);
    }
}
