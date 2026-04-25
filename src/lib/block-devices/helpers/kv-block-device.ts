import { INodeId } from '../../inode';

/**
 * Self-describing metadata about a block device. Sent over the wire by
 * `KvBlockDeviceHttpRouter`'s `GET /blocks` endpoint and read back by
 * `KvBlockDeviceHttpClient.init()` so the client doesn't have to be told
 * the layout up front.
 *
 * Extend this type when the device gains new fields the client needs to
 * know about (e.g. supported features, on-disk version, etc.).
 */
export interface KvBlockDeviceMetadata {
    /**
     * Size in bytes of one block at the moment this metadata was produced.
     * Dynamic — a device may reconfigure itself at runtime (e.g. growing
     * to a larger block size after a reformat). Treat each fetch as a
     * snapshot.
     */
    blockSize: number;

    /**
     * Capacity in blocks: how many blocks the device could hold at the
     * moment this metadata was produced. Valid block IDs are
     * `0..capacityBlocks-1`. Dynamic — a device may be resized at
     * runtime (e.g. attaching more backing storage). Treat each fetch
     * as a snapshot.
     */
    capacityBlocks: number;

    /**
     * The largest block ID currently allocated on the device, or `-1`
     * when no blocks exist. Dynamic — changes as blocks are written and
     * freed. Treat each fetch as a snapshot.
     */
    highestBlockId: number;
}

export abstract class KvBlockDevice {
    protected blockSize: number;
    protected capacityBlocks: number;

    constructor(blockSize: number, capacityBlocks: number) {
        this.blockSize = blockSize;
        this.capacityBlocks = capacityBlocks;
    }

    public getBlockSize(): number {
        return this.blockSize;
    }

    public getCapacityBlocks(): number {
        return this.capacityBlocks;
    }

    public abstract readBlock(blockId: INodeId): Promise<Uint8Array>;

    public abstract writeBlock(blockId: INodeId, data: Uint8Array): Promise<void>;

    public abstract freeBlock(blockId: INodeId): Promise<void>;

    public abstract existsBlock(blockId: INodeId): Promise<boolean>;

    public abstract allocateBlock(): Promise<INodeId>;

    /**
     * Return the largest block ID currently allocated on the device, or
     * `-1` when the device has no blocks. Dynamic — must be recomputed
     * each call; never cache the result.
     */
    public abstract getHighestBlockId(): Promise<INodeId>;

    public abstract format(): Promise<void>;
}
