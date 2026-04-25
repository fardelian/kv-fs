import { KvBlockDevice } from '../block-devices';
import { INodeId } from '../inode';

export class SuperBlock {
    private blockDevice: KvBlockDevice;
    private superBlockId: INodeId;

    public totalBlocks: number = 0;
    public blockSize: number = 0;
    public totalInodes: number = 0;
    public rootDirectoryId: INodeId = 0;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    public async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.superBlockId);

        this.totalBlocks = buffer.readInt32BE(0);
        this.blockSize = buffer.readInt32BE(4);
        this.totalInodes = buffer.readInt32BE(8);
        this.rootDirectoryId = buffer.readInt32BE(12);
    }

    public static async createSuperBlock(
        id: INodeId,
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalInodes: number,
        rootDirectory: INodeId,
    ): Promise<SuperBlock> {
        const buffer = Buffer.alloc(blockDevice.getBlockSize());

        buffer.writeInt32BE(totalBlocks, 0);
        buffer.writeInt32BE(blockDevice.getBlockSize(), 4);
        buffer.writeInt32BE(totalInodes, 8);
        buffer.writeInt32BE(rootDirectory, 12);

        await blockDevice.writeBlock(id, buffer);

        return new SuperBlock(blockDevice, id);
    }
}
