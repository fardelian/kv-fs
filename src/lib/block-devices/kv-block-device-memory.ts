import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { KvError_BD_NotFound, KvError_BD_Overflow } from '../utils';

/**
 * KvBlockDevice that keeps blocks in a regular JS array in process
 * memory. Ephemeral. Freed slots become `undefined` placeholders;
 * trailing placeholders are trimmed on `freeBlock` so
 * `getHighestBlockId` is just `length - 1`.
 */
export class KvBlockDeviceMemory extends KvBlockDevice {
    private readonly blocks: (Uint8Array | undefined)[] = [];

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const block = this.blocks[blockId];
        if (block === undefined) {
            throw new KvError_BD_NotFound(`Block "${blockId}" not found.`);
        }
        return block;
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
        this.blocks[blockId] = blockData;
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.blocks[blockId] = undefined;
        // Trim trailing empties so `getHighestBlockId` is `length - 1`.
        while (this.blocks.length > 0 && this.blocks[this.blocks.length - 1] === undefined) {
            this.blocks.length -= 1;
        }
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return this.blocks[blockId] !== undefined;
    }

    public async allocateBlock(): Promise<INodeId> {
        for (let blockId = 0; blockId < this.blocks.length; blockId++) {
            if (this.blocks[blockId] === undefined) {
                return blockId;
            }
        }
        return this.blocks.length;
    }

    public async getHighestBlockId(): Promise<INodeId> {
        return this.blocks.length - 1;
    }

    public async format(): Promise<void> {
        this.blocks.length = 0;
    }

    /**
     * Test-only accessor: returns the populated blocks (empty slots
     * filtered out) so tests can inspect what's currently stored without
     * reaching into a private field. The leading underscore signals
     * "not part of the public API."
     */
    public _dumpBlocks(): Uint8Array[] {
        return this.blocks.filter((block): block is Uint8Array => block !== undefined);
    }
}
