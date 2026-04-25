import { INode, INodeId } from './kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init } from '../utils/init';
import { dataView } from '../utils/bytes';

export class KvINodeFile extends INode<Uint8Array> {
    public size: number = 0;

    private dataBlockIds: INodeId[] = [];

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        super(blockDevice, id);
    }

    public async init(): Promise<void> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        this.size = view.getInt32(16, false);

        this.dataBlockIds = [];

        let sizeFromBlocks = 0;
        let i = 0;
        while (sizeFromBlocks < this.size) {
            this.dataBlockIds.push(view.getInt32(20 + i * 4, false));
            sizeFromBlocks += this.blockDevice.getBlockSize();
            i++;
        }
    }

    @Init
    public async read(): Promise<Uint8Array> {
        const data = new Uint8Array(this.size);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            const blockData = await this.blockDevice.readBlock(this.dataBlockIds[i]);
            const offset = i * this.blockDevice.getBlockSize();
            const remaining = data.length - offset;
            data.set(blockData.subarray(0, Math.min(blockData.length, remaining)), offset);
        }

        return data;
    }

    @Init
    public async write(data: Uint8Array): Promise<void> {
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

        const buffer = new Uint8Array(this.blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(0, BigInt(this.creationTime.getTime()), false);
        view.setBigUint64(8, BigInt(this.modificationTime.getTime()), false);
        view.setInt32(16, this.size, false);

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            view.setInt32(20 + i * 4, this.dataBlockIds[i], false);
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

        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(0, BigInt(creationTime.getTime()), false);
        view.setBigUint64(8, BigInt(modificationTime.getTime()), false);
        view.setInt32(16, 0, false);

        for (let i = 0; i < (blockDevice.getBlockSize() - 20) / 4; i++) {
            view.setInt32(20 + i * 4, 0, false);
        }

        await blockDevice.writeBlock(id, buffer);

        return new KvINodeFile(blockDevice, id);
    }
}
