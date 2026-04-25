import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';

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
});
