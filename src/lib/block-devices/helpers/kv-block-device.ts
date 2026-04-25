import { INodeId } from '../../inode';

/**
 * Self-describing metadata about a block device. Sent over the wire by
 * `KvBlockDeviceExpressRouter`'s `GET /blocks` endpoint and read back by
 * `KvBlockDeviceHttpClient.init()` so the client doesn't have to be told
 * the layout up front.
 *
 * Extend this type when the device gains new fields the client needs to
 * know about (e.g. supported features, on-disk version, etc.).
 */
export interface KvBlockDeviceMetadata {
    blockSize: number;
    maxBlockId: number;
}

export abstract class KvBlockDevice {
    protected blockSize: number;
    protected capacityBytes: number;

    constructor(blockSize: number, capacityBytes: number) {
        this.blockSize = blockSize;
        this.capacityBytes = capacityBytes;
    }

    public getBlockSize(): number {
        return this.blockSize;
    }

    public getMaxBlockId(): number {
        return Math.floor(this.capacityBytes / this.blockSize);
    }

    public abstract readBlock(blockId: INodeId): Promise<Uint8Array>;

    public abstract writeBlock(blockId: INodeId, data: Uint8Array): Promise<void>;

    public abstract freeBlock(blockId: INodeId): Promise<void>;

    public abstract existsBlock(blockId: INodeId): Promise<boolean>;

    public abstract allocateBlock(): Promise<INodeId>;
}
