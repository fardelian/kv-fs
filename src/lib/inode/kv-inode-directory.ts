import { INode, INodeId } from './helpers/kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init, dataView, utf8Decode, utf8Encode, KvError_FS_NotFound, KvError_INode_NameOverflow } from '../utils';

type DirectoryEntriesList = Map<string, INodeId>;

/**
 * On-disk layout (all integers stored as int32; see review note about
 * signedness — to be revisited):
 *
 * **First block (the inode block, ID = `this.id`):**
 * ```
 *   [0..4)                          creationTime (ms)
 *   [4..8)                          modificationTime (ms)
 *   [8..12)                         numEntries (total across all chained blocks)
 *   [12 + i*ENTRY_STRIDE,           entry i (i in [0, firstBlockCapacity()))
 *    12 + i*ENTRY_STRIDE + 268)
 *   [blockSize - 4, blockSize)      nextBlockId, or -1 if no continuation
 * ```
 *
 * **Continuation block (allocated on demand when entries exceed first block):**
 * ```
 *   [i*ENTRY_STRIDE,                entry i (i in [0, continuationBlockCapacity()))
 *    i*ENTRY_STRIDE + 268)
 *   [blockSize - 4, blockSize)      nextBlockId, or -1 if no further continuation
 * ```
 *
 * **Entry layout (268 bytes, identical in first and continuation blocks):**
 * ```
 *   [0..1)        nameLength (1..255)
 *   [1..256)      UTF-8 name bytes (only first nameLength bytes are meaningful)
 *   [256..260)    iNodeId
 *   [260..268)    reserved padding
 * ```
 */
export class KvINodeDirectory extends INode<DirectoryEntriesList> {
    public static readonly MAX_NAME_LENGTH = 255;
    public static readonly OFFSET_NUM_ENTRIES = 8;
    public static readonly OFFSET_ENTRIES_PREFIX = 12;
    /** Bytes per entry record on disk (1 length byte + 255 name bytes + 4 inode id + 8 padding). */
    public static readonly ENTRY_STRIDE = 268;
    /** Last 4 bytes of every block hold the next-block pointer; -1 means "no continuation". */
    public static readonly NEXT_BLOCK_FOOTER_BYTES = 4;
    public static readonly NO_NEXT_BLOCK = -1;

    private entries: DirectoryEntriesList = new Map();
    /** Continuation blocks holding overflow entries, in chain order. Excludes `this.id`. */
    private continuationBlockIds: INodeId[] = [];

    async init(): Promise<void> {
        await super.init();

        const firstBuffer = await this.blockDevice.readBlock(this.id);
        const firstView = dataView(firstBuffer);
        const numEntries = firstView.getInt32(KvINodeDirectory.OFFSET_NUM_ENTRIES);

        const cap1 = this.firstBlockCapacity();
        const cap2 = this.continuationBlockCapacity();

        const inFirst = Math.min(numEntries, cap1);
        for (let i = 0; i < inFirst; i++) {
            this.parseEntryInto(
                firstBuffer,
                KvINodeDirectory.OFFSET_ENTRIES_PREFIX + i * KvINodeDirectory.ENTRY_STRIDE,
            );
        }

        let entriesRead = inFirst;
        let nextBlockId = firstView.getInt32(firstBuffer.byteLength - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES);

        while (nextBlockId !== KvINodeDirectory.NO_NEXT_BLOCK && entriesRead < numEntries) {
            this.continuationBlockIds.push(nextBlockId);

            const buffer = await this.blockDevice.readBlock(nextBlockId);
            const view = dataView(buffer);

            const inThisBlock = Math.min(numEntries - entriesRead, cap2);
            for (let i = 0; i < inThisBlock; i++) {
                this.parseEntryInto(buffer, i * KvINodeDirectory.ENTRY_STRIDE);
            }
            entriesRead += inThisBlock;

            nextBlockId = view.getInt32(buffer.byteLength - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES);
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

        const entriesArr = Array.from(this.entries);

        for (const [name] of entriesArr) {
            const nameBytes = utf8Encode(name);
            if (nameBytes.length > KvINodeDirectory.MAX_NAME_LENGTH) {
                throw new KvError_INode_NameOverflow(`INode name "${name}" length "${nameBytes.length}" exceeds maximum length "${KvINodeDirectory.MAX_NAME_LENGTH}".`);
            }
        }

        const blockSize = this.blockDevice.getBlockSize();
        const cap1 = this.firstBlockCapacity();
        const cap2 = this.continuationBlockCapacity();
        const inFirst = Math.min(entriesArr.length, cap1);
        const overflow = entriesArr.length - inFirst;
        const requiredContinuationBlocks = overflow > 0 ? Math.ceil(overflow / cap2) : 0;

        // Reconcile chain length: allocate fresh blocks if growing, free
        // trailing blocks if shrinking. Each newly allocated block is
        // immediately claimed with a zero-filled placeholder so subsequent
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

        const firstBuffer = new Uint8Array(blockSize);
        const firstView = dataView(firstBuffer);
        firstView.setInt32(0, this.creationTime.getTime());
        firstView.setInt32(4, this.modificationTime.getTime());
        firstView.setInt32(8, this.entries.size);
        for (let i = 0; i < inFirst; i++) {
            this.serializeEntryInto(
                firstBuffer,
                KvINodeDirectory.OFFSET_ENTRIES_PREFIX + i * KvINodeDirectory.ENTRY_STRIDE,
                entriesArr[i],
            );
        }
        firstView.setInt32(
            blockSize - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES,
            this.continuationBlockIds[0] ?? KvINodeDirectory.NO_NEXT_BLOCK,
        );
        await this.blockDevice.writeBlock(this.id, firstBuffer);

        let entryIdx = inFirst;
        for (let b = 0; b < this.continuationBlockIds.length; b++) {
            const buffer = new Uint8Array(blockSize);
            const view = dataView(buffer);

            const inThisBlock = Math.min(entriesArr.length - entryIdx, cap2);
            for (let i = 0; i < inThisBlock; i++) {
                this.serializeEntryInto(buffer, i * KvINodeDirectory.ENTRY_STRIDE, entriesArr[entryIdx + i]);
            }
            entryIdx += inThisBlock;

            view.setInt32(
                blockSize - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES,
                this.continuationBlockIds[b + 1] ?? KvINodeDirectory.NO_NEXT_BLOCK,
            );

            await this.blockDevice.writeBlock(this.continuationBlockIds[b], buffer);
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
        view.setInt32(0, Date.now());
        view.setInt32(4, Date.now());
        view.setInt32(8, 0);
        view.setInt32(
            buffer.byteLength - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES,
            KvINodeDirectory.NO_NEXT_BLOCK,
        );

        await blockDevice.writeBlock(blockId, buffer);

        const directory = new KvINodeDirectory(blockDevice, blockId);
        await directory.write(new Map());

        return directory;
    }

    /** Number of entries that fit in the first (inode) block. */
    private firstBlockCapacity(): number {
        return Math.floor(
            (this.blockDevice.getBlockSize()
                - KvINodeDirectory.OFFSET_ENTRIES_PREFIX
                - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES)
            / KvINodeDirectory.ENTRY_STRIDE,
        );
    }

    /** Number of entries that fit in a continuation block (no header, just entries + footer). */
    private continuationBlockCapacity(): number {
        return Math.floor(
            (this.blockDevice.getBlockSize() - KvINodeDirectory.NEXT_BLOCK_FOOTER_BYTES)
            / KvINodeDirectory.ENTRY_STRIDE,
        );
    }

    private parseEntryInto(buffer: Uint8Array, baseOffset: number): void {
        const view = dataView(buffer);
        // Name length is unsigned: MAX_NAME_LENGTH is 255, which doesn't fit
        // in a signed int8 (−128..127). Reading via getInt8 would sign-extend
        // any length ≥128 to a negative number and corrupt the name.
        const nameLength = view.getUint8(baseOffset);
        const nameStart = baseOffset + 1;
        const name = utf8Decode(buffer, nameStart, nameStart + nameLength);
        const iNodeId = view.getInt32(baseOffset + 1 + KvINodeDirectory.MAX_NAME_LENGTH);
        this.entries.set(name, iNodeId);
    }

    private serializeEntryInto(buffer: Uint8Array, baseOffset: number, entry: [string, INodeId]): void {
        const [name, iNodeId] = entry;
        const view = dataView(buffer);
        const nameBytes = utf8Encode(name);
        view.setUint8(baseOffset, nameBytes.length);
        buffer.set(nameBytes, baseOffset + 1);
        view.setInt32(baseOffset + 1 + KvINodeDirectory.MAX_NAME_LENGTH, iNodeId);
    }
}
