import { INodeId } from '../inode/kv-inode';

export interface KvBlockDevice {
    blockSize: number;

    readBlock(blockId: INodeId): Promise<Buffer>;

    writeBlock(blockId: INodeId, data: Buffer): Promise<void>;

    freeBlock(blockId: INodeId): Promise<void>;

    existsBlock(blockId: INodeId): Promise<boolean>;

    getNextINodeId(): Promise<INodeId>;
}
