import { KvBlockDevice } from '../block-devices';
import { INodeId } from '../inode';
import { dataView } from '../utils';

export class SuperBlock {
    private blockDevice: KvBlockDevice;
    private superBlockId: INodeId;

    public capacityBytes = 0;
    public blockSize = 0;
    public totalInodes = 0;
    public rootDirectoryId: INodeId = 0;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.superBlockId);
        const view = dataView(buffer);

        this.capacityBytes = view.getUint32(0);
        this.blockSize = view.getUint32(4);
        this.totalInodes = view.getUint32(8);
        this.rootDirectoryId = view.getUint32(12);
    }

    public static async createSuperBlock(
        id: INodeId,
        blockDevice: KvBlockDevice,
        totalInodes: number,
        rootDirectory: INodeId,
    ): Promise<SuperBlock> {
        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);

        // capacityBytes comes straight off the device — the filesystem
        // doesn't get to override it.
        view.setUint32(0, blockDevice.getCapacityBytes());
        view.setUint32(4, blockDevice.getBlockSize());
        view.setUint32(8, totalInodes);
        view.setUint32(12, rootDirectory);

        await blockDevice.writeBlock(id, buffer);

        return new SuperBlock(blockDevice, id);
    }
}
