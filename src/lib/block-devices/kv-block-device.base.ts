import { INodeId } from '../inode';

export abstract class KvBlockDevice {
    protected blockSize: number;

    protected constructor(blockSize: number) {
        this.blockSize = blockSize;
    }

    public async init(): Promise<void> {
    }

    public getBlockSize(): number {
        return this.blockSize;
    }

    public abstract readBlock(blockId: INodeId): Promise<Buffer>;

    public abstract writeBlock(blockId: INodeId, data: Buffer): Promise<void>;

    public abstract freeBlock(blockId: INodeId): Promise<void>;

    public abstract existsBlock(blockId: INodeId): Promise<boolean>;

    public abstract getNextINodeId(): Promise<INodeId>;
}
