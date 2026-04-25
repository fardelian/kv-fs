import { describe, it, expect, beforeEach } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory } from './kv-block-device-memory';
import { KvError_BD_NotFound, KvError_BD_Overflow } from '../utils';

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 1024;

describe('KvBlockDeviceMemory', () => {
    let device: KvBlockDeviceMemory;

    beforeEach(() => {
        device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
    });

    describe('writeBlock + readBlock', () => {
        it('round-trips data padded to the block size', async () => {
            const blockId = faker.number.int({ min: 0, max: 100 });
            const payload = new TextEncoder().encode(faker.lorem.sentence());

            await device.writeBlock(blockId, payload);
            const read = await device.readBlock(blockId);

            expect(read.length).toBe(BLOCK_SIZE);
            expect(Array.from(read.subarray(0, payload.length))).toEqual(Array.from(payload));
            for (let i = payload.length; i < BLOCK_SIZE; i++) {
                expect(read[i]).toBe(0);
            }
        });

        it('round-trips data exactly at the block size', async () => {
            const payload = new Uint8Array(BLOCK_SIZE);
            for (let i = 0; i < BLOCK_SIZE; i++) {
                payload[i] = i & 0xFF;
            }

            await device.writeBlock(0, payload);
            const read = await device.readBlock(0);

            expect(Array.from(read)).toEqual(Array.from(payload));
        });
    });

    describe('writeBlock', () => {
        it('throws KvError_BD_Overflow when data exceeds the block size', async () => {
            const oversize = new Uint8Array(BLOCK_SIZE + 1);

            await expect(device.writeBlock(0, oversize))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });
    });

    describe('readBlock', () => {
        it('throws KvError_BD_NotFound when the block does not exist', async () => {
            await expect(device.readBlock(42))
                .rejects.toBeInstanceOf(KvError_BD_NotFound);
        });
    });

    describe('existsBlock', () => {
        it('returns false for an unused block ID', async () => {
            const blockId = faker.number.int({ min: 0, max: 100 });

            expect(await device.existsBlock(blockId)).toBe(false);
        });

        it('returns true after writing the block', async () => {
            const blockId = 7;
            await device.writeBlock(blockId, new Uint8Array([1, 2, 3]));

            expect(await device.existsBlock(blockId)).toBe(true);
        });
    });

    describe('freeBlock', () => {
        it('removes a previously written block', async () => {
            const blockId = 3;
            await device.writeBlock(blockId, new Uint8Array([9, 9, 9]));

            await device.freeBlock(blockId);

            expect(await device.existsBlock(blockId)).toBe(false);
        });
    });

    describe('allocateBlock', () => {
        it('returns 0 when no blocks exist', async () => {
            expect(await device.allocateBlock()).toBe(0);
        });

        it('returns the next ID after a contiguous run', async () => {
            await device.writeBlock(0, new Uint8Array([1]));
            await device.writeBlock(1, new Uint8Array([1]));
            await device.writeBlock(2, new Uint8Array([1]));

            expect(await device.allocateBlock()).toBe(3);
        });

        it('returns the lowest unused ID even when higher IDs are taken', async () => {
            await device.writeBlock(0, new Uint8Array([1]));
            await device.writeBlock(2, new Uint8Array([1]));

            expect(await device.allocateBlock()).toBe(1);
        });
    });
});
