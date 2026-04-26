import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';

/**
 * LRU cache wrapper around any `KvBlockDevice`. Reads check the cache
 * first and only hit the inner device on a miss; writes invalidate the
 * cached entry so the next read fetches the freshly-stored bytes (some
 * backends — e.g. SQLite — store the exact bytes; others pad to
 * `blockSize`, so the cleanest invariant is "writes drop the cached
 * copy, the next read refreshes it").
 *
 * Designed to sit between the filesystem layer and a slow / remote
 * block device (e.g. `KvBlockDeviceHttpClient`) so that the FUSE
 * layer's many small reads collapse to a handful of network round-trips.
 *
 * The cache keys on block ID and stores raw block bytes (whatever the
 * inner device returned). If you wrap the inner device with encryption,
 * put the cache **outside** the encryption wrapper to cache plaintext
 * (cheaper); put it inside to cache ciphertext (avoids a re-decrypt on
 * every hit but still pays the AEAD verify cost). Either way works.
 */
export class KvCachedBlockDevice extends KvBlockDevice {
    /** Default LRU cache capacity, in blocks. */
    public static readonly DEFAULT_MAX_BLOCKS = 256;

    private readonly inner: KvBlockDevice;
    private readonly maxBlocks: number;
    /**
     * `Map` preserves insertion order; we treat the first key as the
     * least-recently-used and the last key as the most-recently-used.
     */
    private readonly cache = new Map<INodeId, Uint8Array>();

    constructor(inner: KvBlockDevice, maxBlocks: number = KvCachedBlockDevice.DEFAULT_MAX_BLOCKS) {
        super(inner.getBlockSize(), inner.getCapacityBytes());
        if (maxBlocks <= 0) {
            throw new Error(`maxBlocks must be positive; got ${maxBlocks}.`);
        }
        this.inner = inner;
        this.maxBlocks = maxBlocks;
    }

    /** Number of blocks currently held in the cache. */
    public getCacheSize(): number {
        return this.cache.size;
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const cached = this.cache.get(blockId);
        if (cached !== undefined) {
            // Refresh LRU position: delete then re-set so this id moves
            // to the end of the iteration order (= most recently used).
            this.cache.delete(blockId);
            this.cache.set(blockId, cached);
            return cached;
        }
        const block = await this.inner.readBlock(blockId);
        this.put(blockId, block);
        return block;
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        await this.inner.writeBlock(blockId, data);
        // Drop the cached copy — backends differ in what readBlock
        // returns after a short write (some pad to blockSize, some
        // store verbatim), so the safe move is to refresh on next read
        // rather than caching the caller's input verbatim.
        this.cache.delete(blockId);
    }

    /**
     * Partial read can satisfy from cache when the whole block is
     * already there; otherwise pass through to the inner device. We
     * deliberately don't promote a partial read to a full-block fetch
     * here — that would amplify cold reads that only wanted a few
     * bytes.
     */
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) return new Uint8Array(0);
        const cached = this.cache.get(blockId);
        if (cached !== undefined) {
            // Refresh LRU position.
            this.cache.delete(blockId);
            this.cache.set(blockId, cached);
            return cached.slice(start, end);
        }
        return await this.inner.readBlockPartial(blockId, start, end);
    }

    /**
     * Partial write invalidates the cache entry just like a full
     * write — the post-write block contents depend on the inner
     * device's stored bytes plus the splice, and we'd rather refetch
     * than try to splice in the cached copy and risk drift if the
     * inner device pads / mutates differently.
     */
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        await this.inner.writeBlockPartial(blockId, offset, data);
        this.cache.delete(blockId);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.cache.delete(blockId);
        await this.inner.freeBlock(blockId);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        if (this.cache.has(blockId)) return true;
        return await this.inner.existsBlock(blockId);
    }

    public async allocateBlock(): Promise<INodeId> {
        return await this.inner.allocateBlock();
    }

    public async getHighestBlockId(): Promise<INodeId> {
        return await this.inner.getHighestBlockId();
    }

    public async format(): Promise<void> {
        this.cache.clear();
        await this.inner.format();
    }

    private put(blockId: INodeId, data: Uint8Array): void {
        // Evict the LRU entry if we're at capacity and this would be a
        // new key. (If `blockId` is already cached, the delete-then-set
        // a few lines down doesn't grow the size.) `maxBlocks >= 1` is
        // enforced in the constructor, so when `size >= maxBlocks` the
        // map has at least one key — `keys().next().value` is non-null.
        if (!this.cache.has(blockId) && this.cache.size >= this.maxBlocks) {
            const lruKey = this.cache.keys().next().value!;
            this.cache.delete(lruKey);
        }
        // Move to MRU position regardless of whether it was already there.
        this.cache.delete(blockId);
        this.cache.set(blockId, data);
    }
}
