import { INodeId } from '../../inode';

/**
 * Self-describing metadata about a block device. Sent over the wire by
 * `KvBlockDeviceHttpRouter`'s `GET /blocks` endpoint and read back by
 * `KvBlockDeviceHttpClient.init()` so the client doesn't have to be told
 * the layout up front.
 *
 * Extend this type when the device gains new fields the client needs to
 * know about (e.g. supported features, on-disk version, etc.).
 */
export interface KvBlockDeviceMetadata {
    /**
     * Size in bytes of one block at the moment this metadata was produced.
     * Dynamic — a device may reconfigure itself at runtime (e.g. growing
     * to a larger block size after a reformat). Treat each fetch as a
     * snapshot.
     */
    blockSize: number;

    /**
     * Total capacity in bytes at the moment this metadata was produced.
     * Number of addressable blocks is `Math.floor(capacityBytes /
     * blockSize)`. Dynamic — a device may be resized at runtime (e.g.
     * attaching more backing storage). Treat each fetch as a snapshot.
     */
    capacityBytes: number;

    /**
     * The largest block ID currently allocated on the device, or `-1`
     * when no blocks exist. Dynamic — changes as blocks are written and
     * freed. Treat each fetch as a snapshot.
     */
    highestBlockId: number;
}

/**
 * Abstract storage backend that hands out fixed-size blocks addressable
 * by integer ID. Everything in `kv-fs` — filesystems, encryption,
 * remote transport — is built on top of this contract; swap a backend
 * to change where blocks physically live (RAM, disk, SQLite, an HTTP
 * server, …) without touching the layers above.
 *
 * **Contract:**
 * - Block IDs are non-negative integers in `[0, getCapacityBlocks())`.
 * - Reads of an unallocated block throw `KvError_BD_NotFound`.
 * - `blockSize` and `capacityBytes` are dynamic; callers should treat
 *   them as snapshots (see {@link KvBlockDeviceMetadata}).
 *
 * Other behaviour — what happens when `data.length` differs from
 * `getBlockSize()` on write, what `readBlock` returns when the stored
 * payload is shorter than `getBlockSize()`, etc. — is **backend
 * specific**. Most backends pad short writes with zeros and reject
 * over-sized writes with `KvError_BD_Overflow`; sqlite3 stores
 * payloads verbatim. See each subclass for the specifics.
 */
export abstract class KvBlockDevice {
    protected blockSize: number;
    protected capacityBytes: number;

    /**
     * @param blockSize      Bytes per block. All reads return exactly
     *                       this many bytes.
     * @param capacityBytes  Total capacity in bytes. The number of
     *                       addressable blocks is
     *                       `Math.floor(capacityBytes / blockSize)`;
     *                       valid block IDs are in `[0, that)`.
     */
    constructor(blockSize: number, capacityBytes: number) {
        this.blockSize = blockSize;
        this.capacityBytes = capacityBytes;
    }

    /**
     * @returns Bytes per block. Use this when sizing buffers passed to
     *          {@link writeBlock} or interpreting buffers returned by
     *          {@link readBlock}.
     */
    public getBlockSize(): number {
        return this.blockSize;
    }

    /**
     * @returns Total capacity in bytes. Bytes are the source of truth;
     *          {@link getCapacityBlocks} is derived from this.
     */
    public getCapacityBytes(): number {
        return this.capacityBytes;
    }

    /**
     * @returns Total number of addressable blocks
     *          (`Math.floor(capacityBytes / blockSize)`). Valid block
     *          IDs are `0..getCapacityBlocks()-1`.
     */
    public getCapacityBlocks(): number {
        return Math.floor(this.capacityBytes / this.blockSize);
    }

    /**
     * Read the block stored at `blockId`.
     *
     * The exact number of bytes returned is backend-specific (see the
     * class-level note on backend behaviour); most backends return
     * `getBlockSize()` bytes regardless of how much was originally
     * written, while sqlite3 returns whatever was stored.
     *
     * @param blockId  ID of the block to read. Must be in
     *                 `[0, getCapacityBlocks())`.
     * @returns        The raw bytes of the block.
     * @throws KvError_BD_NotFound  If no block has been written at
     *                              `blockId` (or it was freed).
     */
    public abstract readBlock(blockId: INodeId): Promise<Uint8Array>;

    /**
     * Write `data` to the block at `blockId`, replacing any previous
     * content.
     *
     * Behaviour when `data.length !== getBlockSize()` is
     * backend-specific (see the class-level note). Most backends pad
     * short writes with zeros and reject over-sized writes with
     * `KvError_BD_Overflow`; sqlite3 stores payloads verbatim with no
     * size checks.
     *
     * @param blockId  ID of the block to write. Must be in
     *                 `[0, getCapacityBlocks())`.
     * @param data     Bytes to write.
     */
    public abstract writeBlock(blockId: INodeId, data: Uint8Array): Promise<void>;

    /**
     * Release the block at `blockId` so its ID can be reused by a
     * future {@link allocateBlock} call.
     *
     * @param blockId  ID of the block to free.
     */
    public abstract freeBlock(blockId: INodeId): Promise<void>;

    /**
     * Check whether a block has been allocated and not freed at
     * `blockId`.
     *
     * @param blockId  ID to check.
     * @returns        `true` if {@link readBlock} would succeed,
     *                 `false` otherwise.
     */
    public abstract existsBlock(blockId: INodeId): Promise<boolean>;

    /**
     * Pick a block ID that is currently unused. Concrete backends are
     * free to choose any ID in `[0, getCapacityBlocks())`; the typical
     * implementation returns the lowest free ID.
     *
     * The returned ID is not yet "claimed" — call {@link writeBlock}
     * promptly after {@link allocateBlock} to actually occupy it,
     * otherwise a concurrent caller may pick the same ID. Prefer
     * {@link createBlock} when you have the data ready.
     *
     * @returns  A block ID for which {@link existsBlock} currently
     *           returns `false`.
     */
    public abstract allocateBlock(): Promise<INodeId>;

    /**
     * Allocate a new block and write `data` to it, returning the new
     * block ID.
     *
     * The default implementation is a sequential
     * {@link allocateBlock} + {@link writeBlock}, which is a placeholder
     * — it has the same race window as calling them by hand. Backends
     * that have an atomic "allocate-and-write" primitive (e.g. HTTP
     * `POST /blocks` with a body, or a SQL transaction) should override
     * this for both correctness under concurrency and round-trip
     * efficiency.
     *
     * @param data  Bytes to write to the new block.
     * @returns     The ID of the newly allocated block.
     */
    public async createBlock(data: Uint8Array): Promise<INodeId> {
        const blockId = await this.allocateBlock();
        await this.writeBlock(blockId, data);
        return blockId;
    }

    /**
     * Read a sub-range `[start, end)` of the block at `blockId`.
     * Both offsets are block-relative, in bytes.
     *
     * The default implementation reads the whole block via
     * {@link readBlock} and slices out the requested range — i.e. it
     * always pays for a full-block read even if the caller only wants
     * a few bytes. Backends with native partial-read support should
     * override this.
     *
     * @param blockId  ID of the block to read from.
     * @param start    Inclusive start offset (block-relative bytes).
     * @param end      Exclusive end offset (block-relative bytes).
     * @returns        A copy of bytes `[start, end)` from the block;
     *                 empty array when `end <= start`.
     */
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) {
            return new Uint8Array(0);
        }
        const block = await this.readBlock(blockId);
        return block.slice(start, end);
    }

    /**
     * Overwrite a portion of the block at `blockId` with `data`,
     * starting at block-relative `offset`. Bytes outside
     * `[offset, offset + data.length)` are preserved.
     *
     * The default implementation reads the existing block, splices
     * `data` in at `offset`, and writes the full block back — a full
     * read+write per call, even when only a few bytes change. Backends
     * with native partial-write support should override this.
     *
     * @param blockId  ID of the block to update.
     * @param offset   Block-relative offset at which to start writing.
     * @param data     Bytes to write. Throws if
     *                 `offset + data.length > getBlockSize()`.
     */
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        if (data.length === 0) {
            return;
        }
        const block = await this.readBlock(blockId);
        block.set(data, offset);
        await this.writeBlock(blockId, block);
    }

    /**
     * Return the largest block ID currently allocated on the device,
     * or `-1` when the device has no blocks. Dynamic — must be
     * recomputed each call; never cache the result.
     *
     * @returns  The high-water mark of allocated block IDs, or `-1`.
     */
    public abstract getHighestBlockId(): Promise<INodeId>;

    /**
     * Wipe every block on the device. After this call,
     * {@link existsBlock} returns `false` for every ID and
     * {@link getHighestBlockId} returns `-1`. Destructive — typically
     * called from `KvFilesystem.format` before laying down a new
     * superblock.
     */
    public abstract format(): Promise<void>;
}
