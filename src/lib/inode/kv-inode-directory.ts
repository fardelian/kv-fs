import { INode, INodeId } from './helpers/kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init, dataView, utf8Decode, utf8Encode, KvError_FS_NotFound, KvError_INode_NameOverflow } from '../utils';

type DirectoryEntriesList = Map<string, INodeId>;

/**
 * On-disk layout (all on-disk integers are unsigned):
 *
 * **First block (the inode block, ID = `this.id`):**
 * ```
 *   [ 0.. 8)                     creationTime  (uint64, ms)
 *   [ 8..16)                     modificationTime (uint64, ms)
 *   [16..20)                     numEntries (uint32, total across the chain)
 *   [20..blockSize - 8)          packed entries (variable length each)
 *   [blockSize - 8, blockSize - 4)
 *                                entriesInThisBlock (uint32)
 *   [blockSize - 4, blockSize)   nextBlockId (uint32, NO_NEXT_BLOCK if none)
 * ```
 *
 * **Continuation block (allocated on demand when entries overflow):**
 * ```
 *   [0..blockSize - 8)           packed entries (variable length each)
 *   [blockSize - 8, blockSize - 4)
 *                                entriesInThisBlock (uint32)
 *   [blockSize - 4, blockSize)   nextBlockId (uint32, NO_NEXT_BLOCK if none)
 * ```
 *
 * **Entry layout (variable length):**
 * ```
 *   [0..2)                           nameLength (uint16, in UTF-8 bytes)
 *   [2..2 + nameLength)              name bytes (UTF-8)
 *   [2 + nameLength..6 + nameLength) iNodeId (uint32)
 * ```
 *
 * Entries are packed densely; there is no padding between them. A block's
 * unused tail (between the last entry and the footer) is left zeroed. The
 * `entriesInThisBlock` field is what tells the reader where real entries
 * stop, so the zero tail isn't mis-parsed as a string of empty-name entries.
 */
export class KvINodeDirectory extends INode<DirectoryEntriesList> {
    /** Names are at most 16 bits' worth of UTF-8 bytes. Practical limit is also bounded by block size. */
    public static readonly MAX_NAME_LENGTH = 0xFFFF;
    public static readonly OFFSET_NUM_ENTRIES = INode.HEADER_SIZE; // 16
    public static readonly OFFSET_FIRST_ENTRY = INode.HEADER_SIZE + 4; // 20
    /** Per-entry overhead: 2 bytes for `uint16` name length + 4 bytes for `uint32` iNodeId. */
    public static readonly ENTRY_OVERHEAD_BYTES = 2 + 4;
    /** Last 8 bytes of every block: 4 bytes per-block entry count + 4 bytes next-block pointer. */
    public static readonly FOOTER_BYTES = 8;
    public static readonly FOOTER_OFFSET_BLOCK_ENTRY_COUNT_FROM_END = 8;
    public static readonly FOOTER_OFFSET_NEXT_BLOCK_FROM_END = 4;
    /** Sentinel value stored at the next-block pointer when no continuation exists. */
    public static readonly NO_NEXT_BLOCK = 0xFFFFFFFF;

    private entries: DirectoryEntriesList = new Map();
    /** Continuation blocks holding overflow entries, in chain order. Excludes `this.id`. */
    private continuationBlockIds: INodeId[] = [];

    async init(): Promise<void> {
        await super.init();

        const firstBuffer = await this.blockDevice.readBlock(this.id);
        const firstView = dataView(firstBuffer);
        const totalEntries = firstView.getUint32(KvINodeDirectory.OFFSET_NUM_ENTRIES);

        // First block: read header, then walk N entries where N is the
        // first block's per-block count, then follow the chain.
        const inFirstBlock = firstView.getUint32(
            firstBuffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_BLOCK_ENTRY_COUNT_FROM_END,
        );
        this.parseEntriesInto(firstBuffer, KvINodeDirectory.OFFSET_FIRST_ENTRY, inFirstBlock);
        let parsedCount = inFirstBlock;

        let nextBlockId = firstView.getUint32(
            firstBuffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_NEXT_BLOCK_FROM_END,
        );

        while (parsedCount < totalEntries && nextBlockId !== KvINodeDirectory.NO_NEXT_BLOCK) {
            this.continuationBlockIds.push(nextBlockId);

            const buffer = await this.blockDevice.readBlock(nextBlockId);
            const view = dataView(buffer);

            const inThisBlock = view.getUint32(
                buffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_BLOCK_ENTRY_COUNT_FROM_END,
            );
            this.parseEntriesInto(buffer, 0, inThisBlock);
            parsedCount += inThisBlock;

            nextBlockId = view.getUint32(
                buffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_NEXT_BLOCK_FROM_END,
            );
        }
    }

    @Init
    public async read(): Promise<DirectoryEntriesList> {
        return new Map(this.entries);
    }

    @Init
    public async write(newEntries: DirectoryEntriesList): Promise<void> {
        this.entries = newEntries;
        this.modificationTime = new Date();

        const blockSize = this.blockDevice.getBlockSize();
        const firstBlockEntryArea = blockSize
            - KvINodeDirectory.OFFSET_FIRST_ENTRY
            - KvINodeDirectory.FOOTER_BYTES;
        const continuationEntryArea = blockSize - KvINodeDirectory.FOOTER_BYTES;

        // Validate every name and pre-compute its UTF-8 encoding so we don't
        // re-encode in the planning pass below.
        const encoded: { name: string; nameBytes: Uint8Array; iNodeId: INodeId; entrySize: number }[] = [];
        for (const [name, iNodeId] of this.entries) {
            const nameBytes = utf8Encode(name);
            if (nameBytes.length > KvINodeDirectory.MAX_NAME_LENGTH) {
                throw new KvError_INode_NameOverflow(`INode name "${name}" length "${nameBytes.length}" exceeds maximum length "${KvINodeDirectory.MAX_NAME_LENGTH}".`);
            }
            const entrySize = KvINodeDirectory.ENTRY_OVERHEAD_BYTES + nameBytes.length;
            // A single entry must fit inside one (continuation) block —
            // entries are not split across blocks. The first block has less
            // room than a continuation thanks to its 12-byte header, but the
            // planning loop below moves oversize-for-first-block entries to a
            // continuation, so the relevant bound is the larger one.
            if (entrySize > continuationEntryArea) {
                throw new KvError_INode_NameOverflow(`INode entry "${name}" needs ${entrySize} bytes but a single block can only hold ${continuationEntryArea} bytes of entries.`);
            }
            encoded.push({ name, nameBytes, iNodeId, entrySize });
        }

        // Plan: pack entries into blocks front-to-back, spilling into a new
        // block whenever the next entry would overflow the current one.
        const blocks: typeof encoded[] = [[]];
        let currentBlockBytesAvailable = firstBlockEntryArea;
        for (const entry of encoded) {
            if (entry.entrySize > currentBlockBytesAvailable) {
                blocks.push([]);
                currentBlockBytesAvailable = continuationEntryArea;
            }
            blocks[blocks.length - 1].push(entry);
            currentBlockBytesAvailable -= entry.entrySize;
        }

        const requiredContinuationBlocks = blocks.length - 1;

        // Reconcile chain length. Each newly allocated block is claimed
        // immediately with a zero-filled placeholder so subsequent
        // allocateBlock() calls don't hand back the same ID before the real
        // content is written below. (Mirrors KvINodeFile.resize.)
        while (this.continuationBlockIds.length < requiredContinuationBlocks) {
            const newId = await this.blockDevice.allocateBlock();
            await this.blockDevice.writeBlock(newId, new Uint8Array(blockSize));
            this.continuationBlockIds.push(newId);
        }
        while (this.continuationBlockIds.length > requiredContinuationBlocks) {
            const id = this.continuationBlockIds.pop()!;
            await this.blockDevice.freeBlock(id);
        }

        // Serialize each block.
        for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
            const buffer = new Uint8Array(blockSize);
            const view = dataView(buffer);

            let offset: number;
            if (blockIdx === 0) {
                view.setBigUint64(INode.OFFSET_CREATION_TIME, BigInt(this.creationTime.getTime()));
                view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, BigInt(this.modificationTime.getTime()));
                view.setUint32(KvINodeDirectory.OFFSET_NUM_ENTRIES, this.entries.size);
                offset = KvINodeDirectory.OFFSET_FIRST_ENTRY;
            } else {
                offset = 0;
            }

            for (const entry of blocks[blockIdx]) {
                view.setUint16(offset, entry.nameBytes.length);
                buffer.set(entry.nameBytes, offset + 2);
                view.setUint32(offset + 2 + entry.nameBytes.length, entry.iNodeId);
                offset += entry.entrySize;
            }

            // Footer: per-block entry count, then next-block pointer.
            view.setUint32(
                blockSize - KvINodeDirectory.FOOTER_OFFSET_BLOCK_ENTRY_COUNT_FROM_END,
                blocks[blockIdx].length,
            );
            const nextBlockId = blockIdx + 1 < blocks.length
                ? this.continuationBlockIds[blockIdx]
                : KvINodeDirectory.NO_NEXT_BLOCK;
            view.setUint32(
                blockSize - KvINodeDirectory.FOOTER_OFFSET_NEXT_BLOCK_FROM_END,
                nextBlockId,
            );

            const targetBlockId = blockIdx === 0 ? this.id : this.continuationBlockIds[blockIdx - 1];
            await this.blockDevice.writeBlock(targetBlockId, buffer);
        }
    }

    @Init
    public async addEntry(name: string, iNodeId: INodeId): Promise<void> {
        this.entries.set(name, iNodeId);
        await this.write(this.entries);
    }

    @Init
    public async removeEntry(name: string): Promise<void> {
        this.entries.delete(name);
        await this.write(this.entries);
    }

    @Init
    public async getEntry(name: string): Promise<INodeId> {
        const iNodeId = this.entries.get(name);
        if (iNodeId === undefined) {
            throw new KvError_FS_NotFound(`Directory entry "${name}" not found.`);
        }
        return iNodeId;
    }

    @Init
    public async hasEntry(name: string): Promise<boolean> {
        return this.entries.has(name);
    }

    public static async createEmptyDirectory(blockDevice: KvBlockDevice, blockId: INodeId): Promise<KvINodeDirectory> {
        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);
        const now = BigInt(Date.now());
        view.setBigUint64(INode.OFFSET_CREATION_TIME, now);
        view.setBigUint64(INode.OFFSET_MODIFICATION_TIME, now);
        view.setUint32(KvINodeDirectory.OFFSET_NUM_ENTRIES, 0);
        view.setUint32(
            buffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_BLOCK_ENTRY_COUNT_FROM_END,
            0,
        );
        view.setUint32(
            buffer.byteLength - KvINodeDirectory.FOOTER_OFFSET_NEXT_BLOCK_FROM_END,
            KvINodeDirectory.NO_NEXT_BLOCK,
        );

        await blockDevice.writeBlock(blockId, buffer);

        const directory = new KvINodeDirectory(blockDevice, blockId);
        await directory.write(new Map());

        return directory;
    }

    /** Parse `count` packed entries starting at `startOffset` into `this.entries`. */
    private parseEntriesInto(buffer: Uint8Array, startOffset: number, count: number): void {
        const view = dataView(buffer);
        let offset = startOffset;
        for (let i = 0; i < count; i++) {
            const nameLength = view.getUint16(offset);
            const name = utf8Decode(buffer, offset + 2, offset + 2 + nameLength);
            const iNodeId = view.getUint32(offset + 2 + nameLength);
            this.entries.set(name, iNodeId);
            offset += KvINodeDirectory.ENTRY_OVERHEAD_BYTES + nameLength;
        }
    }
}
