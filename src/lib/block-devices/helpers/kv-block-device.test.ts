import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { MockBlockDevice } from '../../../mocks/kv-block-device.mock';

describe('KvBlockDevice (base)', () => {
    describe('getBlockSize', () => {
        it('returns the block size passed to the constructor', () => {
            const blockSize = faker.helpers.arrayElement([512, 1024, 2048, 4096, 8192, 16384]);
            const device = new MockBlockDevice(blockSize);

            expect(device.getBlockSize()).toBe(blockSize);
        });

        it('returns the same value across repeated calls', () => {
            const blockSize = faker.number.int({ min: 1, max: 1_000_000 });
            const device = new MockBlockDevice(blockSize);

            expect(device.getBlockSize()).toBe(blockSize);
        });

        it('keeps each instance independent', () => {
            const sizeA = faker.number.int({ min: 1, max: 1_000 });
            const sizeB = faker.number.int({ min: 1_001, max: 1_000_000 });

            const a = new MockBlockDevice(sizeA);
            const b = new MockBlockDevice(sizeB);

            expect(a.getBlockSize()).toBe(sizeA);
            expect(b.getBlockSize()).toBe(sizeB);
        });
    });

    describe('getCapacityBytes', () => {
        it('returns the capacityBytes passed to the constructor', () => {
            const capacityBytes = faker.number.int({ min: 1, max: 1_000_000 });
            const device = new MockBlockDevice(4096, capacityBytes);

            expect(device.getCapacityBytes()).toBe(capacityBytes);
        });

        it('keeps each instance independent', () => {
            const a = new MockBlockDevice(4096, 4096 * 7);
            const b = new MockBlockDevice(4096, 4096 * 99);

            expect(a.getCapacityBytes()).toBe(4096 * 7);
            expect(b.getCapacityBytes()).toBe(4096 * 99);
        });
    });

    describe('getCapacityBlocks', () => {
        it('returns capacityBytes / blockSize when they divide evenly', () => {
            const blockSize = 4096;
            const blocks = faker.number.int({ min: 1, max: 1000 });
            const device = new MockBlockDevice(blockSize, blockSize * blocks);

            expect(device.getCapacityBlocks()).toBe(blocks);
        });

        it('floors when capacityBytes is not a multiple of blockSize', () => {
            const blockSize = 4096;
            const device = new MockBlockDevice(blockSize, blockSize * 3 + 1234);

            expect(device.getCapacityBlocks()).toBe(3);
        });

        it('returns 0 when capacityBytes is smaller than blockSize', () => {
            const blockSize = 4096;
            const device = new MockBlockDevice(blockSize, blockSize - 1);

            expect(device.getCapacityBlocks()).toBe(0);
        });
    });
});
