import { INode, INodeId, KV_INODE_KIND_FILE } from './helpers/kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init, dataView } from '../utils';

/**
 * On-disk layout (extends `INode`'s 16-byte header):
 * ```
 *   [ 0..16)              creationTime + modificationTime  (see INode)
 *   [16..24)              size  (uint64)
 *   [24..blockSize - 4)   direct data block IDs (uint32 each, packed)
 *   [blockSize - 4, blockSize)
 *                         indirectBlockId (uint32; NO_BLOCK if unused)
 * ```
 *
 * For files small enough to fit, every data block ID lives directly in
 * the inode (the "direct" array). Once a file grows past
 * `maxDirectBlocks()`, an extra **indirect block** is allocated; its
 * entire contents are a packed array of `uint32` data block IDs (so an
 * indirect block holds `blockSize / 4` more pointers). With 4 KiB
 * blocks that's 1018 direct + 1024 indirect = 2042 blocks ≈ 8 MiB max
 * file size before doubly-indirect (a future step) becomes necessary.
 */
export class KvINodeFile extends INode<Uint8Array> {
    public static readonly OFFSET_SIZE = INode.HEADER_SIZE; // 24
    public static readonly OFFSET_DATA_BLOCK_IDS = INode.HEADER_SIZE + 8; // 32
    public static readonly DATA_BLOCK_ID_SIZE = 4;
    public static readonly INDIRECT_FOOTER_BYTES = 4;
    public static readonly NO_BLOCK = 0xFFFFFFFF;

    public override get kind(): number {
        return KV_INODE_KIND_FILE;
    }

    public size = 0;

    private dataBlockIds: INodeId[] = [];
    /** Block holding the overflow data-block-id list, or null if not allocated. */
    private indirectBlockId: INodeId | null = null;
    private position = 0;

    /** Number of data block IDs that fit directly in the inode block. */
    public maxDirectBlocks(): number {
        return Math.floor(
            (this.blockDevice.getBlockSize() - KvINodeFile.OFFSET_DATA_BLOCK_IDS - KvINodeFile.INDIRECT_FOOTER_BYTES)
            / KvINodeFile.DATA_BLOCK_ID_SIZE,
        );
    }

    async init(): Promise<void> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        this.size = Number(view.getBigUint64(KvINodeFile.OFFSET_SIZE));

        this.dataBlockIds = [];
        const blockSize = this.blockDevice.getBlockSize();
        const requiredBlocks = this.size === 0 ? 0 : Math.ceil(this.size / blockSize);
        const maxDirect = this.maxDirectBlocks();

        const directCount = Math.min(requiredBlocks, maxDirect);
        for (let i = 0; i < directCount; i++) {
            const offset = KvINodeFile.OFFSET_DATA_BLOCK_IDS + i * KvINodeFile.DATA_BLOCK_ID_SIZE;
            this.dataBlockIds.push(view.getUint32(offset));
        }

        const storedIndirect = view.getUint32(blockSize - KvINodeFile.INDIRECT_FOOTER_BYTES);
        this.indirectBlockId = storedIndirect === KvINodeFile.NO_BLOCK ? null : storedIndirect;

        // Pull overflow IDs out of the indirect block if the file is big
        // enough to need it.
        if (requiredBlocks > maxDirect && this.indirectBlockId !== null) {
            const indirectBuffer = await this.blockDevice.readBlock(this.indirectBlockId);
            const indirectView = dataView(indirectBuffer);
            const indirectCount = requiredBlocks - maxDirect;
            for (let i = 0; i < indirectCount; i++) {
                this.dataBlockIds.push(indirectView.getUint32(i * KvINodeFile.DATA_BLOCK_ID_SIZE));
            }
        }
    }

    /**
     * Set the read/write position. Setting it past EOF extends the file with
     * zero-filled blocks (POSIX `lseek` does not extend; this method does, by
     * design — it is not strictly POSIX `lseek`).
     */
    @Init
    public async setPos(newPosition: number): Promise<void> {
        if (newPosition < 0) {
            throw new Error(`Position must be non-negative; got ${newPosition}.`);
        }

        if (newPosition > this.size) {
            await this.resize(newPosition);
            this.modificationTime = new Date();
            await this.writeMetadata();
        }

        this.position = newPosition;
    }

    /** Current read/write position, in bytes from the start. POSIX `ftell` analogue. */
    public getPos(): number {
        return this.position;
    }

    /**
     * Set the file size to `length`. Modeled on POSIX `ftruncate(3p)`:
     * - If `length` is greater than the current size, the file is extended and
     *   the extended area reads as zero.
     * - If `length` is less than the current size, the trailing data is removed.
     * - The current read/write position is **not** changed (it may end up
     *   beyond the new EOF after a shrink — subsequent reads return empty,
     *   subsequent writes will extend the file again).
     */
    @Init
    public async truncate(length = 0): Promise<void> {
        if (length < 0) {
            throw new Error(`Length must be non-negative; got ${length}.`);
        }
        if (length === this.size) return;

        await this.resize(length);
        this.modificationTime = new Date();
        await this.writeMetadata();
    }

    /**
     * Read up to `length` bytes from the current position. If `length` is
     * omitted, reads to the end of the file. Advances the position by however
     * many bytes were returned. At EOF, returns an empty buffer.
     */
    @Init
    public async read(length?: number): Promise<Uint8Array> {
        const blockSize = this.blockDevice.getBlockSize();
        const startPos = this.position;
        const remaining = this.size - startPos;

        if (remaining <= 0) {
            return new Uint8Array(0);
        }

        const readLen = length === undefined ? remaining : Math.min(length, remaining);
        if (readLen === 0) {
            return new Uint8Array(0);
        }

        const endPos = startPos + readLen;
        const data = new Uint8Array(readLen);

        const firstBlock = Math.floor(startPos / blockSize);
        const lastBlock = Math.floor((endPos - 1) / blockSize);

        for (let b = firstBlock; b <= lastBlock; b++) {
            const block = await this.blockDevice.readBlock(this.dataBlockIds[b]);
            const blockStart = b * blockSize;

            const sliceStart = Math.max(startPos, blockStart);
            const sliceEnd = Math.min(endPos, blockStart + blockSize);
            const sliceLen = sliceEnd - sliceStart;

            const blockOffset = sliceStart - blockStart;
            const dataOffset = sliceStart - startPos;

            data.set(block.subarray(blockOffset, blockOffset + sliceLen), dataOffset);
        }

        this.position = endPos;
        return data;
    }

    /**
     * Write `data` at the current position, advancing the position by
     * `data.length`. Extends the file if writing past EOF. Does not shrink the
     * file when overwriting in-place — use `truncate` for that.
     */
    @Init
    public async write(data: Uint8Array): Promise<void> {
        if (data.length === 0) return;

        const blockSize = this.blockDevice.getBlockSize();
        const startPos = this.position;
        const endPos = startPos + data.length;

        if (endPos > this.size) {
            await this.resize(endPos);
        }

        const firstBlock = Math.floor(startPos / blockSize);
        const lastBlock = Math.floor((endPos - 1) / blockSize);

        for (let b = firstBlock; b <= lastBlock; b++) {
            const blockStart = b * blockSize;

            const writeStart = Math.max(startPos, blockStart);
            const writeEnd = Math.min(endPos, blockStart + blockSize);
            const writeLen = writeEnd - writeStart;

            const dataOffset = writeStart - startPos;
            const offsetInBlock = writeStart - blockStart;

            let blockBuffer: Uint8Array;
            if (offsetInBlock === 0 && writeLen === blockSize) {
                // Full block overwrite — no need to read the existing block.
                blockBuffer = data.subarray(dataOffset, dataOffset + blockSize);
            } else {
                // Partial — read-modify-write so we don't clobber neighbours.
                const existing = await this.blockDevice.readBlock(this.dataBlockIds[b]);
                blockBuffer = new Uint8Array(existing);
                blockBuffer.set(data.subarray(dataOffset, dataOffset + writeLen), offsetInBlock);
            }

            await this.blockDevice.writeBlock(this.dataBlockIds[b], blockBuffer);
        }

        this.position = endPos;
        this.modificationTime = new Date();
        await this.writeMetadata();
    }

    @Init
    public async unlink(): Promise<void> {
        for (const blockId of this.dataBlockIds) {
            await this.blockDevice.freeBlock(blockId);
        }

        if (this.indirectBlockId !== null) {
            await this.blockDevice.freeBlock(this.indirectBlockId);
            this.indirectBlockId = null;
        }

        await this.blockDevice.freeBlock(this.id);

        this.size = 0;
        this.position = 0;
        this.modificationTime = new Date();
    }

    private async resize(length: number): Promise<void> {
        const blockSize = this.blockDevice.getBlockSize();
        const requiredBlocks = length === 0 ? 0 : Math.ceil(length / blockSize);

        if (length < this.size) {
            while (this.dataBlockIds.length > requiredBlocks) {
                await this.blockDevice.freeBlock(this.dataBlockIds.pop()!);
            }

            // Zero the partial tail of the last retained block past the new EOF.
            // Maintains the invariant that bytes past `size` inside an
            // allocated block are zero, so a later extend reads as zero.
            if (this.dataBlockIds.length > 0 && length % blockSize !== 0) {
                const lastIdx = this.dataBlockIds.length - 1;
                const offsetInLastBlock = length - lastIdx * blockSize;
                const block = await this.blockDevice.readBlock(this.dataBlockIds[lastIdx]);
                const cleaned = new Uint8Array(block);
                cleaned.fill(0, offsetInLastBlock);
                await this.blockDevice.writeBlock(this.dataBlockIds[lastIdx], cleaned);
            }
        } else {
            while (this.dataBlockIds.length < requiredBlocks) {
                const newId = await this.blockDevice.allocateBlock();
                this.dataBlockIds.push(newId);
                await this.blockDevice.writeBlock(newId, new Uint8Array(blockSize));
            }
        }

        this.size = length;
    }

    /**
     * Persist the inode block (timestamps, size, direct + indirect data block
     * IDs). Allocates an indirect block on demand the first time the file
     * grows past `maxDirectBlocks()`; frees it once the file shrinks back
     * below that threshold.
     */
    private async writeMetadata(): Promise<void> {
        const blockSize = this.blockDevice.getBlockSize();
        const maxDirect = this.maxDirectBlocks();
        const overflowCount = Math.max(0, this.dataBlockIds.length - maxDirect);

        // Allocate the indirect block on demand — claim the slot with a
        // zero-filled placeholder before any subsequent allocateBlock so
        // we don't get the same ID back.
        if (overflowCount > 0 && this.indirectBlockId === null) {
            this.indirectBlockId = await this.blockDevice.allocateBlock();
            await this.blockDevice.writeBlock(this.indirectBlockId, new Uint8Array(blockSize));
        } else if (overflowCount === 0 && this.indirectBlockId !== null) {
            await this.blockDevice.freeBlock(this.indirectBlockId);
            this.indirectBlockId = null;
        }

        // Inode block: header + size + direct ids + indirect pointer.
        const buffer = new Uint8Array(blockSize);
        const view = dataView(buffer);
        view.setUint8(INode.OFFSET_KIND, KV_INODE_KIND_FILE);
        view.setBigUint64(INode.OFFSET_CREATION_TIME, BigInt(this.creationTime.getTime()));
        view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, BigInt(this.modificationTime.getTime()));
        view.setBigUint64(KvINodeFile.OFFSET_SIZE, BigInt(this.size));

        const directCount = Math.min(this.dataBlockIds.length, maxDirect);
        for (let i = 0; i < directCount; i++) {
            view.setUint32(KvINodeFile.OFFSET_DATA_BLOCK_IDS + i * KvINodeFile.DATA_BLOCK_ID_SIZE, this.dataBlockIds[i]);
        }
        view.setUint32(
            blockSize - KvINodeFile.INDIRECT_FOOTER_BYTES,
            this.indirectBlockId ?? KvINodeFile.NO_BLOCK,
        );

        await this.blockDevice.writeBlock(this.id, buffer);

        // Indirect block, if needed.
        if (this.indirectBlockId !== null) {
            const indirectBuffer = new Uint8Array(blockSize);
            const indirectView = dataView(indirectBuffer);
            for (let i = 0; i < overflowCount; i++) {
                indirectView.setUint32(
                    i * KvINodeFile.DATA_BLOCK_ID_SIZE,
                    this.dataBlockIds[maxDirect + i],
                );
            }
            await this.blockDevice.writeBlock(this.indirectBlockId, indirectBuffer);
        }
    }

    public static async createEmptyFile(blockDevice: KvBlockDevice): Promise<KvINodeFile> {
        const id = await blockDevice.allocateBlock();
        const creationTime = new Date();
        const modificationTime = new Date();

        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setUint8(INode.OFFSET_KIND, KV_INODE_KIND_FILE);
        view.setBigUint64(INode.OFFSET_CREATION_TIME, BigInt(creationTime.getTime()));
        view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, BigInt(modificationTime.getTime()));
        view.setBigUint64(KvINodeFile.OFFSET_SIZE, 0n);
        view.setUint32(
            buffer.byteLength - KvINodeFile.INDIRECT_FOOTER_BYTES,
            KvINodeFile.NO_BLOCK,
        );

        await blockDevice.writeBlock(id, buffer);

        return new KvINodeFile(blockDevice, id);
    }
}
