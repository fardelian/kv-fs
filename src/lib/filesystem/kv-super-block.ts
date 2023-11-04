import { KvBlockDevice } from '../block-device/types';
import { INodeId } from '../inode/kv-inode';
import { Init } from '../types';

export class SuperBlock extends Init {
    private blockDevice: KvBlockDevice;
    private superBlockId: INodeId;

    public totalBlocks: number = 0;
    public blockSize: number = 0;
    public totalInodes: number = 0;
    public rootDirectoryId: INodeId = 0;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        super();
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    public async init(): Promise<this> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.superBlockId);

        this.totalBlocks = buffer.readInt32BE(0);
        this.blockSize = buffer.readInt32BE(4);
        this.totalInodes = buffer.readInt32BE(8);
        this.rootDirectoryId = buffer.readInt32BE(12);

        return this;
    }

    public static async createSuperBlock(
        id: INodeId,
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalInodes: number,
        rootDirectory: INodeId,
    ): Promise<SuperBlock> {
        const buffer = Buffer.alloc(blockDevice.blockSize);

        buffer.writeInt32BE(totalBlocks, 0);
        buffer.writeInt32BE(blockDevice.blockSize, 4);
        buffer.writeInt32BE(totalInodes, 8);
        buffer.writeInt32BE(rootDirectory, 12);

        await blockDevice.writeBlock(id, buffer);

        const superBlock = new SuperBlock(blockDevice, id);
        return await superBlock.init();
    }
}
