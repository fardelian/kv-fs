import { jest } from '@jest/globals';
import { KvBlockDevice } from '../lib/block-devices';
import { INodeId } from '../lib/inode';

/** A `KvBlockDevice` whose every method is a `jest.fn` so tests can configure return values and assert call args. */
export class MockBlockDevice extends KvBlockDevice {
    public readBlock = jest.fn<(blockId: INodeId) => Promise<Buffer>>();
    public writeBlock = jest.fn<(blockId: INodeId, data: Buffer) => Promise<void>>();
    public freeBlock = jest.fn<(blockId: INodeId) => Promise<void>>();
    public existsBlock = jest.fn<(blockId: INodeId) => Promise<boolean>>();
    public allocateBlock = jest.fn<() => Promise<INodeId>>();

    constructor(blockSize: number = 4096) {
        super(blockSize);
    }
}
