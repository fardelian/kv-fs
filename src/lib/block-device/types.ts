export interface KvBlockDevice {
    blockSize: number;

    readBlock(blockId: number): Buffer;

    writeBlock(blockId: number, data: Buffer): void;

    freeBlock(blockId: number): void;

    existsBlock(blockId: number): boolean;

    getNextINodeId(): number;
}
