import { describe, it, expect } from 'test-globals';
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
});
