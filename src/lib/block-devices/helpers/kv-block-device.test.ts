import { describe, it, expect } from 'bun:test';
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

    describe('createBlock (default implementation)', () => {
        it('allocates a new block, writes data to it, and returns the new id', async () => {
            const device = new MockBlockDevice(4096);
            device.allocateBlock.mockResolvedValueOnce(7);
            device.writeBlock.mockResolvedValueOnce(undefined);

            const data = new Uint8Array([1, 2, 3]);
            const id = await device.createBlock(data);

            expect(device.allocateBlock).toHaveBeenCalledTimes(1);
            expect(device.writeBlock).toHaveBeenCalledTimes(1);
            expect(device.writeBlock).toHaveBeenCalledWith(7, data);
            expect(id).toBe(7);
        });

        it('propagates errors from writeBlock', async () => {
            const device = new MockBlockDevice(4096);
            device.allocateBlock.mockResolvedValueOnce(0);
            const err = new Error('write failed');
            device.writeBlock.mockRejectedValueOnce(err);

            await expect(device.createBlock(new Uint8Array(1))).rejects.toBe(err);
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

    describe('batch (default implementation)', () => {
        it('dispatches read, write, and free ops in order', async () => {
            const device = new MockBlockDevice(4096);
            const payload = new Uint8Array([9, 9, 9]);
            device.readBlock.mockResolvedValueOnce(payload);
            device.writeBlock.mockResolvedValueOnce(undefined);
            device.freeBlock.mockResolvedValueOnce(undefined);

            const results = await device.batch([
                { op: 'read', blockId: 1 },
                { op: 'write', blockId: 2, data: new Uint8Array([1, 2]) },
                { op: 'free', blockId: 3 },
            ]);

            expect(results).toHaveLength(3);
            expect(results[0]).toEqual({ ok: true, data: payload });
            expect(results[1]).toEqual({ ok: true });
            expect(results[2]).toEqual({ ok: true });
            expect(device.readBlock).toHaveBeenCalledWith(1);
            expect(device.writeBlock).toHaveBeenCalledWith(2, new Uint8Array([1, 2]));
            expect(device.freeBlock).toHaveBeenCalledWith(3);
        });

        it('captures per-op errors without aborting the batch', async () => {
            const device = new MockBlockDevice(4096);
            device.readBlock.mockRejectedValueOnce(new Error('boom'));
            device.writeBlock.mockResolvedValueOnce(undefined);

            const results = await device.batch([
                { op: 'read', blockId: 1 },
                { op: 'write', blockId: 2, data: new Uint8Array([0]) },
            ]);

            expect(results[0]).toEqual({ ok: false, error: 'boom' });
            expect(results[1]).toEqual({ ok: true });
        });

        it('stringifies non-Error rejections', async () => {
            const device = new MockBlockDevice(4096);
            device.freeBlock.mockRejectedValueOnce('plain-string-error');

            const results = await device.batch([{ op: 'free', blockId: 1 }]);

            expect(results[0]).toEqual({ ok: false, error: 'plain-string-error' });
        });

        it('returns an empty result list for an empty batch', async () => {
            const device = new MockBlockDevice(4096);
            const results = await device.batch([]);
            expect(results).toEqual([]);
        });

        it('dispatches alloc and surfaces the new blockId', async () => {
            const device = new MockBlockDevice(4096);
            device.allocateBlock.mockResolvedValueOnce(42);

            const results = await device.batch([{ op: 'alloc' }]);

            expect(results[0]).toEqual({ ok: true, blockId: 42 });
            expect(device.allocateBlock).toHaveBeenCalledTimes(1);
        });

        it('dispatches partial-read via the default readBlockPartial (read+slice)', async () => {
            const device = new MockBlockDevice(4096);
            const block = new Uint8Array(4096);
            for (let i = 0; i < block.length; i++) block[i] = i & 0xff;
            device.readBlock.mockResolvedValueOnce(block);

            const results = await device.batch([
                { op: 'partial-read', blockId: 1, start: 10, end: 16 },
            ]);

            expect(results[0].ok).toBe(true);
            const got = (results[0] as { ok: true; data: Uint8Array }).data;
            expect(Array.from(got)).toEqual([10, 11, 12, 13, 14, 15]);
        });

        it('dispatches partial-write via the default writeBlockPartial (RMW)', async () => {
            const device = new MockBlockDevice(4096);
            const block = new Uint8Array(4096);
            device.readBlock.mockResolvedValueOnce(block);
            device.writeBlock.mockResolvedValueOnce(undefined);

            const data = new Uint8Array([0xab, 0xcd]);
            const results = await device.batch([
                { op: 'partial-write', blockId: 2, offset: 100, data },
            ]);

            expect(results[0]).toEqual({ ok: true });
            const [writtenId, writtenData] = device.writeBlock.mock.calls[0];
            expect(writtenId).toBe(2);
            expect(writtenData[100]).toBe(0xab);
            expect(writtenData[101]).toBe(0xcd);
        });
    });

    describe('default partial helpers', () => {
        it('readBlockPartial returns an empty buffer when end <= start', async () => {
            const device = new MockBlockDevice(4096);
            const empty = await device.readBlockPartial(0, 10, 10);
            expect(empty.length).toBe(0);
            // Equal-bounds path short-circuits before any readBlock fetch.
            expect(device.readBlock).not.toHaveBeenCalled();
        });

        it('writeBlockPartial is a no-op when data is empty', async () => {
            const device = new MockBlockDevice(4096);
            await device.writeBlockPartial(0, 0, new Uint8Array(0));
            expect(device.readBlock).not.toHaveBeenCalled();
            expect(device.writeBlock).not.toHaveBeenCalled();
        });
    });

    describe('readBlocksWithDecoys', () => {
        it('returns real reads in input order with no decoys requested', async () => {
            const device = new MockBlockDevice(4096);
            const a = new Uint8Array([1]);
            const b = new Uint8Array([2]);
            device.readBlock.mockImplementation(async (id) => {
                if (id === 5) return a;
                if (id === 9) return b;
                throw new Error(`unexpected id ${id}`);
            });

            const result = await device.readBlocksWithDecoys([5, 9]);

            expect(result).toEqual([a, b]);
        });

        it('mixes in decoys but still returns only the real reads', async () => {
            const device = new MockBlockDevice(4096);
            device.getHighestBlockId.mockResolvedValue(7);
            const real = new Uint8Array([42]);
            const decoy = new Uint8Array([0]);
            device.readBlock.mockImplementation(async (id) => (id === 3 ? real : decoy));

            const result = await device.readBlocksWithDecoys([3], 4);

            expect(result).toEqual([real]);
            expect(device.readBlock.mock.calls.length).toBe(5);
        });

        it('skips decoy generation when the device has no allocated blocks', async () => {
            const device = new MockBlockDevice(4096);
            device.getHighestBlockId.mockResolvedValue(-1);
            device.readBlock.mockResolvedValue(new Uint8Array([1]));

            const result = await device.readBlocksWithDecoys([0], 5);

            expect(result).toHaveLength(1);
            expect(device.readBlock).toHaveBeenCalledTimes(1);
        });

        it('throws when a real read fails inside the batch', async () => {
            const device = new MockBlockDevice(4096);
            device.readBlock.mockRejectedValue(new Error('disk gone'));

            await expect(device.readBlocksWithDecoys([1])).rejects.toThrow(/Read of block 1 failed/);
        });
    });

    describe('CAS (getBlockVersion / writeBlockIfMatch)', () => {
        it('starts every block at version 0', async () => {
            const device = new MockBlockDevice(4096);
            expect(await device.getBlockVersion(0)).toBe(0);
            expect(await device.getBlockVersion(99)).toBe(0);
        });

        it('writes when the expected version matches and returns the bumped version', async () => {
            const device = new MockBlockDevice(4096);
            device.writeBlock.mockResolvedValue(undefined);
            const data = new Uint8Array([7]);

            const next = await device.writeBlockIfMatch(1, 0, data);

            expect(next).toBe(1);
            expect(await device.getBlockVersion(1)).toBe(1);
            expect(device.writeBlock).toHaveBeenCalledWith(1, data);
        });

        it('returns null without writing when the expected version is stale', async () => {
            const device = new MockBlockDevice(4096);
            device.writeBlock.mockResolvedValue(undefined);

            await device.writeBlockIfMatch(1, 0, new Uint8Array([1])); // version → 1
            const stale = await device.writeBlockIfMatch(1, 0, new Uint8Array([2]));

            expect(stale).toBeNull();
            expect(device.writeBlock).toHaveBeenCalledTimes(1);
            expect(await device.getBlockVersion(1)).toBe(1);
        });

        it('bumps versions independently per block ID', async () => {
            const device = new MockBlockDevice(4096);
            device.writeBlock.mockResolvedValue(undefined);

            await device.writeBlockIfMatch(1, 0, new Uint8Array([1]));
            await device.writeBlockIfMatch(1, 1, new Uint8Array([2]));
            await device.writeBlockIfMatch(2, 0, new Uint8Array([3]));

            expect(await device.getBlockVersion(1)).toBe(2);
            expect(await device.getBlockVersion(2)).toBe(1);
            expect(await device.getBlockVersion(3)).toBe(0);
        });
    });
});
