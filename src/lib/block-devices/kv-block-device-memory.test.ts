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

    describe('getHighestBlockId', () => {
        it('returns -1 when no blocks exist', async () => {
            expect(await device.getHighestBlockId()).toBe(-1);
        });

        it('returns the only block ID when one block exists', async () => {
            const blockId = faker.number.int({ min: 0, max: 100 });
            await device.writeBlock(blockId, new Uint8Array([1]));

            expect(await device.getHighestBlockId()).toBe(blockId);
        });

        it('returns the largest ID across a sparse allocation', async () => {
            await device.writeBlock(0, new Uint8Array([1]));
            await device.writeBlock(7, new Uint8Array([1]));
            await device.writeBlock(3, new Uint8Array([1]));

            expect(await device.getHighestBlockId()).toBe(7);
        });

        it('drops back to the next-highest after the top block is freed', async () => {
            await device.writeBlock(2, new Uint8Array([1]));
            await device.writeBlock(5, new Uint8Array([1]));

            await device.freeBlock(5);

            expect(await device.getHighestBlockId()).toBe(2);
        });

        it('returns -1 after every block is freed', async () => {
            await device.writeBlock(4, new Uint8Array([1]));
            await device.freeBlock(4);

            expect(await device.getHighestBlockId()).toBe(-1);
        });
    });

    describe('readBlockPartial', () => {
        it('returns a freshly-allocated slice over the requested range', async () => {
            await device.writeBlock(0, new Uint8Array([1, 2, 3, 4, 5]));

            const slice = await device.readBlockPartial(0, 1, 4);

            expect(Array.from(slice)).toEqual([2, 3, 4]);
            // Mutating the returned slice must not affect the stored block.
            slice[0] = 0xff;
            const fresh = await device.readBlock(0);
            expect(fresh[1]).toBe(2);
        });

        it('returns an empty buffer when end <= start (no fetch)', async () => {
            const slice = await device.readBlockPartial(0, 5, 5);
            expect(slice.length).toBe(0);
        });

        it('throws KvError_BD_NotFound when the block does not exist', async () => {
            await expect(device.readBlockPartial(7, 0, 4)).rejects.toBeInstanceOf(KvError_BD_NotFound);
        });
    });

    describe('writeBlockPartial', () => {
        it('splices into the existing block in place', async () => {
            await device.writeBlock(3, new Uint8Array(BLOCK_SIZE));

            await device.writeBlockPartial(3, 100, new Uint8Array([0xa, 0xb, 0xc]));

            const block = await device.readBlock(3);
            expect(block[99]).toBe(0);
            expect(block[100]).toBe(0xa);
            expect(block[101]).toBe(0xb);
            expect(block[102]).toBe(0xc);
            expect(block[103]).toBe(0);
        });

        it('throws KvError_BD_Overflow when offset + data exceeds blockSize', async () => {
            await device.writeBlock(0, new Uint8Array(BLOCK_SIZE));

            await expect(device.writeBlockPartial(0, BLOCK_SIZE - 2, new Uint8Array(4)))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });

        it('throws KvError_BD_NotFound when the block does not exist', async () => {
            await expect(device.writeBlockPartial(99, 0, new Uint8Array([1])))
                .rejects.toBeInstanceOf(KvError_BD_NotFound);
        });

        it('is a no-op when data is empty', async () => {
            await device.writeBlock(2, new Uint8Array([1, 2, 3]));

            await device.writeBlockPartial(2, 0, new Uint8Array(0));

            // Still readable; existing block unchanged at the head.
            const block = await device.readBlock(2);
            expect(block[0]).toBe(1);
        });
    });
});
