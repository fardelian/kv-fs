import { INode, INodeId } from './helpers/kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init, dataView } from '../utils';

/**
 * On-disk layout (extends `INode`'s 16-byte header):
 * ```
 *   [ 0..16)            creationTime + modificationTime  (see INode)
 *   [16..24)            size  (uint64)
 *   [24..)              data block IDs (uint32 each, packed densely)
 * ```
 */
export class KvINodeFile extends INode<Uint8Array> {
    public static readonly OFFSET_SIZE = INode.HEADER_SIZE; // 16
    public static readonly OFFSET_DATA_BLOCK_IDS = INode.HEADER_SIZE + 8; // 24
    public static readonly DATA_BLOCK_ID_SIZE = 4;

    public size = 0;

    private dataBlockIds: INodeId[] = [];
    private position = 0;

    async init(): Promise<void> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        this.size = Number(view.getBigUint64(KvINodeFile.OFFSET_SIZE));

        this.dataBlockIds = [];

        let sizeFromBlocks = 0;
        let i = 0;
        while (sizeFromBlocks < this.size) {
            const offset = KvINodeFile.OFFSET_DATA_BLOCK_IDS + i * KvINodeFile.DATA_BLOCK_ID_SIZE;
            this.dataBlockIds.push(view.getUint32(offset));
            sizeFromBlocks += this.blockDevice.getBlockSize();
            i++;
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

        await this.blockDevice.freeBlock(this.id);

        this.size = 0;
        this.position = 0;
        this.modificationTime = new Date();
    }

    /**
     * Resize the in-memory + on-device block list to match `length` bytes.
     * Allocates and zero-fills new blocks on extend; frees trailing blocks on
     * shrink and zeroes any bytes past the new EOF inside the last retained
     * block (so a later extend within that block reads as zero).
     *
     * Does **not** update `modificationTime` or write the inode metadata —
     * callers do that once after they've finished their own work, so we don't
     * persist the inode block twice for one logical operation.
     */
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

    /** Persist the inode block (timestamps, size, data-block-id list). */
    private async writeMetadata(): Promise<void> {
        const buffer = new Uint8Array(this.blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(INode.OFFSET_CREATION_TIME, BigInt(this.creationTime.getTime()));
        view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, BigInt(this.modificationTime.getTime()));
        view.setBigUint64(KvINodeFile.OFFSET_SIZE, BigInt(this.size));

        for (let i = 0; i < this.dataBlockIds.length; i++) {
            view.setUint32(KvINodeFile.OFFSET_DATA_BLOCK_IDS + i * KvINodeFile.DATA_BLOCK_ID_SIZE, this.dataBlockIds[i]);
        }

        await this.blockDevice.writeBlock(this.id, buffer);
    }

    public static async createEmptyFile(blockDevice: KvBlockDevice): Promise<KvINodeFile> {
        const id = await blockDevice.allocateBlock();
        const creationTime = new Date();
        const modificationTime = new Date();

        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(INode.OFFSET_CREATION_TIME, BigInt(creationTime.getTime()));
        view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, BigInt(modificationTime.getTime()));
        view.setBigUint64(KvINodeFile.OFFSET_SIZE, 0n);

        // Zero the data-block-id area so a later init() doesn't read garbage.
        // (`new Uint8Array` already starts zeroed; this is a defensive no-op
        // that keeps intent visible.)

        await blockDevice.writeBlock(id, buffer);

        return new KvINodeFile(blockDevice, id);
    }
}
