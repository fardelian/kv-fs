import { KvBlockDevice } from '../block-devices';
import { INodeId } from '../inode';
import { dataView } from '../utils';

export class SuperBlock {
    private blockDevice: KvBlockDevice;
    private superBlockId: INodeId;

    public totalBlocks = 0;
    public blockSize = 0;
    public totalInodes = 0;
    public rootDirectoryId: INodeId = 0;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    public async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.superBlockId);
        const view = dataView(buffer);

        this.totalBlocks = view.getInt32(0, false);
        this.blockSize = view.getInt32(4, false);
        this.totalInodes = view.getInt32(8, false);
        this.rootDirectoryId = view.getInt32(12, false);
    }

    public static async createSuperBlock(
        id: INodeId,
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalInodes: number,
        rootDirectory: INodeId,
    ): Promise<SuperBlock> {
        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);

        view.setInt32(0, totalBlocks, false);
        view.setInt32(4, blockDevice.getBlockSize(), false);
        view.setInt32(8, totalInodes, false);
        view.setInt32(12, rootDirectory, false);

        await blockDevice.writeBlock(id, buffer);

        return new SuperBlock(blockDevice, id);
    }
}
