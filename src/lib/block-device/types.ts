import { INodeId } from '../inode/kv-inode';
import { Init } from '../types';

export abstract class KvBlockDevice extends Init {
    public blockSize: number;

    constructor(blockSize: number) {
        super();
        this.blockSize = blockSize;
    }

    public abstract readBlock(blockId: INodeId): Promise<Buffer>;

    public abstract writeBlock(blockId: INodeId, data: Buffer): Promise<void>;

    public abstract freeBlock(blockId: INodeId): Promise<void>;

    public abstract existsBlock(blockId: INodeId): Promise<boolean>;

    public abstract getNextINodeId(): Promise<INodeId>;
}
