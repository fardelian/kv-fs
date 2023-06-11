import { KvBlockDevice } from '../block-device/types';

export class SuperBlock {
    private blockDevice: KvBlockDevice;
    private superBlockId: number;

    public totalBlocks: number;
    public blockSize: number;
    public totalInodes: number;
    public rootDirectoryId: number;

    constructor(blockDevice: KvBlockDevice, superBlockId: number) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;

        const buffer = this.blockDevice.readBlock(superBlockId);

        this.totalBlocks = buffer.readInt32BE(0);
        this.blockSize = buffer.readInt32BE(4);
        this.totalInodes = buffer.readInt32BE(8);
        this.rootDirectoryId = buffer.readInt32BE(12);
    }

    public static createSuperBlock(
        id: number,
        blockDevice: KvBlockDevice,
        totalBlocks: number,
        totalInodes: number,
        rootDirectory: number,
    ): SuperBlock {
        const buffer = Buffer.alloc(blockDevice.blockSize);

        buffer.writeInt32BE(totalBlocks, 0);
        buffer.writeInt32BE(blockDevice.blockSize, 4);
        buffer.writeInt32BE(totalInodes, 8);
        buffer.writeInt32BE(rootDirectory, 12);

        blockDevice.writeBlock(id, buffer);

        return new SuperBlock(blockDevice, id);
    }
}
