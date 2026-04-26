import { describe, it, expect } from 'bun:test';
import { KvCachedBlockDevice } from './kv-cached-block-device';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';

const BLOCK_SIZE = 64;

function makeDevice(maxBlocks?: number) {
    const inner = new MockBlockDevice(BLOCK_SIZE, BLOCK_SIZE * 1024);
    const cached = new KvCachedBlockDevice(inner, maxBlocks);
    return { inner, cached };
}

function bytes(byte: number): Uint8Array {
    const buf = new Uint8Array(BLOCK_SIZE);
    buf.fill(byte);
    return buf;
}

describe('KvCachedBlockDevice', () => {
    describe('constructor', () => {
        it('inherits block size and capacity from the inner device', () => {
            const { cached } = makeDevice();
            expect(cached.getBlockSize()).toBe(BLOCK_SIZE);
            expect(cached.getCapacityBytes()).toBe(BLOCK_SIZE * 1024);
        });

        it.each([0, -1, -100])('rejects non-positive maxBlocks (%i)', (n) => {
            const inner = new MockBlockDevice(BLOCK_SIZE);
            expect(() => new KvCachedBlockDevice(inner, n)).toThrow(/positive/);
        });

        it('defaults maxBlocks when omitted', () => {
            const { cached } = makeDevice();
            expect(cached.getCacheSize()).toBe(0);
        });
    });

    describe('readBlock', () => {
        it('passes through to the inner device on a cache miss', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(7));

            const result = await cached.readBlock(3);

            expect(inner.readBlock).toHaveBeenCalledTimes(1);
            expect(inner.readBlock).toHaveBeenCalledWith(3);
            expect(result[0]).toBe(7);
        });

        it('serves a cache hit without calling the inner device', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(11));

            await cached.readBlock(3);
            expect(inner.readBlock).toHaveBeenCalledTimes(1);

            const second = await cached.readBlock(3);
            expect(inner.readBlock).toHaveBeenCalledTimes(1); // still 1 — hit
            expect(second[0]).toBe(11);
        });
    });

    describe('writeBlock', () => {
        it('writes through to the inner device', async () => {
            const { inner, cached } = makeDevice();
            inner.writeBlock.mockResolvedValueOnce(undefined);

            const data = bytes(0x42);
            await cached.writeBlock(5, data);

            expect(inner.writeBlock).toHaveBeenCalledWith(5, data);
        });

        it('invalidates the cached entry so the next read refetches', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(1));
            inner.writeBlock.mockResolvedValueOnce(undefined);
            inner.readBlock.mockResolvedValueOnce(bytes(2));

            // miss -> cache filled
            await cached.readBlock(0);
            // invalidates cache
            await cached.writeBlock(0, bytes(2));
            // miss -> refetch
            const after = await cached.readBlock(0);

            expect(inner.readBlock).toHaveBeenCalledTimes(2);
            expect(after[0]).toBe(2);
        });
    });

    describe('freeBlock', () => {
        it('invalidates the cache and forwards to the inner device', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(9));
            inner.freeBlock.mockResolvedValueOnce(undefined);

            await cached.readBlock(2);
            await cached.freeBlock(2);

            expect(inner.freeBlock).toHaveBeenCalledWith(2);

            inner.readBlock.mockResolvedValueOnce(bytes(0));
            await cached.readBlock(2);
            // The post-free read was a miss → inner.readBlock called twice total.
            expect(inner.readBlock).toHaveBeenCalledTimes(2);
        });
    });

    describe('existsBlock', () => {
        it('returns true without calling the inner device when cached', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(0));
            await cached.readBlock(7);

            const exists = await cached.existsBlock(7);

            expect(exists).toBe(true);
            expect(inner.existsBlock).not.toHaveBeenCalled();
        });

        it('falls through to the inner device when not cached', async () => {
            const { inner, cached } = makeDevice();
            inner.existsBlock.mockResolvedValueOnce(true);

            const exists = await cached.existsBlock(99);

            expect(exists).toBe(true);
            expect(inner.existsBlock).toHaveBeenCalledWith(99);
        });
    });

    describe('passthroughs', () => {
        it('allocateBlock forwards to the inner device', async () => {
            const { inner, cached } = makeDevice();
            inner.allocateBlock.mockResolvedValueOnce(42);

            expect(await cached.allocateBlock()).toBe(42);
        });

        it('getHighestBlockId forwards to the inner device', async () => {
            const { inner, cached } = makeDevice();
            inner.getHighestBlockId.mockResolvedValueOnce(11);

            expect(await cached.getHighestBlockId()).toBe(11);
        });

        it('format clears the cache and forwards', async () => {
            const { inner, cached } = makeDevice();
            inner.readBlock.mockResolvedValueOnce(bytes(1));
            inner.format.mockResolvedValueOnce(undefined);

            await cached.readBlock(0);
            await cached.format();

            expect(cached.getCacheSize()).toBe(0);
            expect(inner.format).toHaveBeenCalledTimes(1);
        });
    });

    describe('LRU eviction', () => {
        it('evicts the oldest entry when at capacity', async () => {
            const { inner, cached } = makeDevice(2);
            inner.readBlock.mockResolvedValueOnce(bytes(1));
            inner.readBlock.mockResolvedValueOnce(bytes(2));
            inner.readBlock.mockResolvedValueOnce(bytes(3));

            await cached.readBlock(0); // cache: [0]
            await cached.readBlock(1); // cache: [0, 1]
            await cached.readBlock(2); // cache: [1, 2] — 0 evicted

            expect(cached.getCacheSize()).toBe(2);

            // Reading 0 again must miss.
            inner.readBlock.mockResolvedValueOnce(bytes(1));
            await cached.readBlock(0);
            expect(inner.readBlock).toHaveBeenCalledTimes(4);
        });

        it('promotes recently-used entries away from the LRU position', async () => {
            const { inner, cached } = makeDevice(2);
            inner.readBlock.mockResolvedValueOnce(bytes(1));
            inner.readBlock.mockResolvedValueOnce(bytes(2));

            await cached.readBlock(0); // cache: [0]
            await cached.readBlock(1); // cache: [0, 1]
            await cached.readBlock(0); // hit; cache: [1, 0] — 0 promoted to MRU

            inner.readBlock.mockResolvedValueOnce(bytes(3));
            await cached.readBlock(2); // miss; evicts 1 not 0; cache: [0, 2]

            // 0 is still cached.
            await cached.readBlock(0);
            expect(inner.readBlock).toHaveBeenCalledTimes(3);

            // 1 is gone.
            inner.readBlock.mockResolvedValueOnce(bytes(2));
            await cached.readBlock(1);
            expect(inner.readBlock).toHaveBeenCalledTimes(4);
        });
    });

    describe('readBlockPartial', () => {
        it('returns an empty buffer without touching the inner device when end <= start', async () => {
            const { inner, cached } = makeDevice();

            const out = await cached.readBlockPartial(0, 5, 5);

            expect(out.length).toBe(0);
            expect(inner.readBlock).not.toHaveBeenCalled();
        });

        it('serves the slice from the cache when the whole block is already cached', async () => {
            const { inner, cached } = makeDevice();
            const block = bytes(0xab);
            block[10] = 0x01;
            block[11] = 0x02;
            block[12] = 0x03;
            inner.readBlock.mockResolvedValueOnce(block);

            // Prime the cache via a full read.
            await cached.readBlock(4);
            expect(inner.readBlock).toHaveBeenCalledTimes(1);

            const slice = await cached.readBlockPartial(4, 10, 13);
            expect(Array.from(slice)).toEqual([0x01, 0x02, 0x03]);
            // No additional inner fetch — the cached copy answered.
            expect(inner.readBlock).toHaveBeenCalledTimes(1);
        });

        it('falls through to the inner device on a cache miss without polluting the cache', async () => {
            const { inner, cached } = makeDevice();
            // MockBlockDevice doesn't override readBlockPartial, so its
            // base default routes through readBlock + slice.
            const block = bytes(0);
            block[0] = 0x11;
            block[1] = 0x22;
            inner.readBlock.mockResolvedValueOnce(block);

            const slice = await cached.readBlockPartial(7, 0, 2);

            expect(Array.from(slice)).toEqual([0x11, 0x22]);
            expect(inner.readBlock).toHaveBeenCalledWith(7);
            // The cache must not absorb the inner full-block read — partial
            // requests shouldn't pollute the LRU.
            expect(cached.getCacheSize()).toBe(0);
        });
    });

    describe('writeBlockPartial', () => {
        it('passes through to the inner partial write and invalidates the cached entry', async () => {
            const { inner, cached } = makeDevice();
            // Prime the cache via a full read.
            inner.readBlock.mockResolvedValueOnce(bytes(0));
            await cached.readBlock(2);
            expect(cached.getCacheSize()).toBe(1);

            // The base default writeBlockPartial does read+splice+write.
            inner.readBlock.mockResolvedValueOnce(bytes(0));
            inner.writeBlock.mockResolvedValueOnce(undefined);

            await cached.writeBlockPartial(2, 4, new Uint8Array([1, 2, 3]));

            expect(inner.writeBlock).toHaveBeenCalled();
            // Cached copy must drop so the next read fetches the post-splice block.
            expect(cached.getCacheSize()).toBe(0);
        });
    });
});
