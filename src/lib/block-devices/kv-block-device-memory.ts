import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode';
import { KvError_BD_NotFound, KvError_BD_Overflow } from '../utils/errors';

/** KvBlockDevice that keeps blocks in a `Map` in process memory. Ephemeral. */
export class KvBlockDeviceMemory extends KvBlockDevice {
    private readonly blocks = new Map<INodeId, Uint8Array>();

    constructor(blockSize: number, capacityBytes: number) {
        super(blockSize, capacityBytes);
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const block = this.blocks.get(blockId);
        if (!block) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        return block;
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
        this.blocks.set(blockId, blockData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.blocks.delete(blockId);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return this.blocks.has(blockId);
    }

    public async allocateBlock(): Promise<INodeId> {
        let blockId = 0;
        while (this.blocks.has(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
