import { describe, it, expect, beforeEach } from 'bun:test';
import { faker } from '@faker-js/faker';
import { SuperBlock } from './kv-super-block';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';
import { dataView, KvError_FS_FormatVersion } from '../utils';

const BLOCK_SIZE = 4096;

function makeSuperBlockBuffer(
    formatVersion: number,
    capacityBytes: number,
    blockSize: number,
    totalInodes: number,
    rootDirectoryId: number,
): Uint8Array {
    const buffer = new Uint8Array(BLOCK_SIZE);
    const view = dataView(buffer);
    view.setUint32(SuperBlock.OFFSET_FORMAT_VERSION, formatVersion);
    view.setBigUint64(SuperBlock.OFFSET_CAPACITY_BYTES, BigInt(capacityBytes));
    view.setUint32(SuperBlock.OFFSET_BLOCK_SIZE, blockSize);
    view.setUint32(SuperBlock.OFFSET_TOTAL_INODES, totalInodes);
    view.setUint32(SuperBlock.OFFSET_ROOT_DIRECTORY_ID, rootDirectoryId);
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
            const capacityBytes = faker.number.int({ min: 1, max: 100_000_000 });
            const blockSize = faker.helpers.arrayElement([512, 1024, 2048, 4096, 8192]);
            const totalInodes = faker.number.int({ min: 1, max: 1000 });
            const rootDirectoryId = faker.number.int({ min: 1, max: 100 });

            blockDevice.readBlock.mockResolvedValueOnce(
                makeSuperBlockBuffer(SuperBlock.FORMAT_VERSION, capacityBytes, blockSize, totalInodes, rootDirectoryId),
            );

            const superBlock = new SuperBlock(blockDevice, superBlockId);
            await superBlock.init();

            expect(blockDevice.readBlock).toHaveBeenCalledTimes(1);
            expect(blockDevice.readBlock).toHaveBeenCalledWith(superBlockId);

            expect(superBlock.formatVersion).toBe(SuperBlock.FORMAT_VERSION);
            expect(superBlock.capacityBytes).toBe(capacityBytes);
            expect(superBlock.blockSize).toBe(blockSize);
            expect(superBlock.totalInodes).toBe(totalInodes);
            expect(superBlock.rootDirectoryId).toBe(rootDirectoryId);
        });

        it('rejects volumes with the wrong format version', async () => {
            blockDevice.readBlock.mockResolvedValueOnce(
                makeSuperBlockBuffer(SuperBlock.FORMAT_VERSION + 1, 4096 * 16, 4096, 4, 1),
            );

            const superBlock = new SuperBlock(blockDevice, 0);
            await expect(superBlock.init()).rejects.toBeInstanceOf(KvError_FS_FormatVersion);
        });

        it('propagates errors from the block device', async () => {
            const error = new Error(faker.lorem.sentence());
            blockDevice.readBlock.mockRejectedValueOnce(error);

            const superBlock = new SuperBlock(blockDevice, 0);

            await expect(superBlock.init()).rejects.toBe(error);
        });
    });

    describe('createSuperBlock', () => {
        it('writes the superblock to the given ID and uses the device capacity for capacityBytes', async () => {
            const id = faker.number.int({ min: 0, max: 100 });
            const capacityBlocks = faker.number.int({ min: 1, max: 10_000 });
            const capacityBytes = BLOCK_SIZE * capacityBlocks;
            const totalInodes = faker.number.int({ min: 1, max: 1000 });
            const rootDirectoryId = faker.number.int({ min: 1, max: 100 });

            const sized = new MockBlockDevice(BLOCK_SIZE, capacityBytes);
            sized.writeBlock.mockResolvedValueOnce(undefined);

            const superBlock = await SuperBlock.createSuperBlock(
                id,
                sized,
                totalInodes,
                rootDirectoryId,
            );

            expect(superBlock).toBeInstanceOf(SuperBlock);

            expect(sized.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenBuffer] = sized.writeBlock.mock.calls[0];

            expect(writtenId).toBe(id);
            expect(writtenBuffer.length).toBe(BLOCK_SIZE);

            const view = dataView(writtenBuffer);
            expect(view.getUint32(SuperBlock.OFFSET_FORMAT_VERSION)).toBe(SuperBlock.FORMAT_VERSION);
            expect(Number(view.getBigUint64(SuperBlock.OFFSET_CAPACITY_BYTES))).toBe(capacityBytes);
            expect(view.getUint32(SuperBlock.OFFSET_BLOCK_SIZE)).toBe(BLOCK_SIZE);
            expect(view.getUint32(SuperBlock.OFFSET_TOTAL_INODES)).toBe(totalInodes);
            expect(view.getUint32(SuperBlock.OFFSET_ROOT_DIRECTORY_ID)).toBe(rootDirectoryId);
        });

        it('uses the block device block size for the buffer', async () => {
            const customBlockSize = 8192;
            const customBlockDevice = new MockBlockDevice(customBlockSize);
            customBlockDevice.writeBlock.mockResolvedValueOnce(undefined);

            await SuperBlock.createSuperBlock(0, customBlockDevice, 10, 1);

            const [, writtenBuffer] = customBlockDevice.writeBlock.mock.calls[0];
            expect(writtenBuffer.length).toBe(customBlockSize);
            expect(dataView(writtenBuffer).getUint32(SuperBlock.OFFSET_BLOCK_SIZE)).toBe(customBlockSize);
        });
    });
});
