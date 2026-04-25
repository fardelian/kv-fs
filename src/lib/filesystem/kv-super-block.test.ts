import { describe, it, expect, beforeEach } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { SuperBlock } from './kv-super-block';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';
import { dataView } from '../utils/bytes';

const BLOCK_SIZE = 4096;

function makeSuperBlockBuffer(
    totalBlocks: number,
    blockSize: number,
    totalInodes: number,
    rootDirectoryId: number,
): Uint8Array {
    const buffer = new Uint8Array(BLOCK_SIZE);
    const view = dataView(buffer);
    view.setInt32(0, totalBlocks, false);
    view.setInt32(4, blockSize, false);
    view.setInt32(8, totalInodes, false);
    view.setInt32(12, rootDirectoryId, false);
    return buffer;
}

describe('SuperBlock', () => {
    let blockDevice: MockBlockDevice;

    beforeEach(() => {
        blockDevice = new MockBlockDevice(BLOCK_SIZE);
    });

    describe('init', () => {
        it('reads the superblock at the configured ID and parses layout fields', async () => {
            const superBlockId = faker.number.int({ min: 0, max: 100 });
            const totalBlocks = faker.number.int({ min: 1, max: 10_000 });
            const blockSize = faker.helpers.arrayElement([512, 1024, 2048, 4096, 8192]);
            const totalInodes = faker.number.int({ min: 1, max: 1000 });
            const rootDirectoryId = faker.number.int({ min: 1, max: 100 });

            blockDevice.readBlock.mockResolvedValueOnce(
                makeSuperBlockBuffer(totalBlocks, blockSize, totalInodes, rootDirectoryId),
            );

            const superBlock = new SuperBlock(blockDevice, superBlockId);
            await superBlock.init();

            expect(blockDevice.readBlock).toHaveBeenCalledTimes(1);
            expect(blockDevice.readBlock).toHaveBeenCalledWith(superBlockId);

            expect(superBlock.totalBlocks).toBe(totalBlocks);
            expect(superBlock.blockSize).toBe(blockSize);
            expect(superBlock.totalInodes).toBe(totalInodes);
            expect(superBlock.rootDirectoryId).toBe(rootDirectoryId);
        });

        it('propagates errors from the block device', async () => {
            const error = new Error(faker.lorem.sentence());
            blockDevice.readBlock.mockRejectedValueOnce(error);

            const superBlock = new SuperBlock(blockDevice, 0);

            await expect(superBlock.init()).rejects.toBe(error);
        });
    });

    describe('createSuperBlock', () => {
        it('writes the superblock to the given ID and returns a SuperBlock instance', async () => {
            const id = faker.number.int({ min: 0, max: 100 });
            const totalBlocks = faker.number.int({ min: 1, max: 10_000 });
            const totalInodes = faker.number.int({ min: 1, max: 1000 });
            const rootDirectoryId = faker.number.int({ min: 1, max: 100 });

            blockDevice.writeBlock.mockResolvedValueOnce(undefined);

            const superBlock = await SuperBlock.createSuperBlock(
                id,
                blockDevice,
                totalBlocks,
                totalInodes,
                rootDirectoryId,
            );

            expect(superBlock).toBeInstanceOf(SuperBlock);

            expect(blockDevice.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenBuffer] = blockDevice.writeBlock.mock.calls[0];

            expect(writtenId).toBe(id);
            expect(writtenBuffer.length).toBe(BLOCK_SIZE);

            const view = dataView(writtenBuffer);
            expect(view.getInt32(0, false)).toBe(totalBlocks);
            expect(view.getInt32(4, false)).toBe(BLOCK_SIZE);
            expect(view.getInt32(8, false)).toBe(totalInodes);
            expect(view.getInt32(12, false)).toBe(rootDirectoryId);
        });

        it('uses the block device block size for the buffer (not the totalBlocks count)', async () => {
            const customBlockSize = 8192;
            const customBlockDevice = new MockBlockDevice(customBlockSize);
            customBlockDevice.writeBlock.mockResolvedValueOnce(undefined);

            await SuperBlock.createSuperBlock(0, customBlockDevice, 100, 10, 1);

            const [, writtenBuffer] = customBlockDevice.writeBlock.mock.calls[0];
            expect(writtenBuffer.length).toBe(customBlockSize);
            expect(dataView(writtenBuffer).getInt32(4, false)).toBe(customBlockSize);
        });
    });
});
