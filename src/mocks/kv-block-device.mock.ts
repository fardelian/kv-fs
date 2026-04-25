import { jest } from '@jest/globals';
import { KvBlockDevice } from '../lib/block-devices';
import { INodeId } from '../lib/inode';

/** A `KvBlockDevice` whose every method is a `jest.fn` so tests can configure return values and assert call args. */
export class MockBlockDevice extends KvBlockDevice {
    public readBlock = jest.fn<(blockId: INodeId) => Promise<Uint8Array>>();
    public writeBlock = jest.fn<(blockId: INodeId, data: Uint8Array) => Promise<void>>();
    public freeBlock = jest.fn<(blockId: INodeId) => Promise<void>>();
    public existsBlock = jest.fn<(blockId: INodeId) => Promise<boolean>>();
    public allocateBlock = jest.fn<() => Promise<INodeId>>();
    public getHighestBlockId = jest.fn<() => Promise<INodeId>>();

    constructor(blockSize = 4096, capacityBytes: number = blockSize * 1024) {
        super(blockSize, capacityBytes);
    }
}
