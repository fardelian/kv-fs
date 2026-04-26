import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { dataView, KvError_BD_Overflow } from '../utils';

/**
 * One journal record describing an atomic mutation. The journal is
 * append-only; replay walks records in order and re-applies any whose
 * `committed` bit hasn't been flipped.
 */
export interface KvJournalRecord {
    /** Monotonic per-journal sequence number assigned at append time. */
    seq: number;
    /** What kind of mutation. */
    op: 'write' | 'free';
    blockId: INodeId;
    /** Whether the underlying op has been applied AND its completion flushed. */
    committed: boolean;
    /** Wall-clock timestamp of the append, in ms since epoch. */
    timestampMs: number;
}

/**
 * Write-Ahead Log (WAL) wrapper. Sits between the filesystem layer and
 * a backing block device, journaling every mutating op (write, free) to
 * a dedicated **journal block** *before* applying it. After the op
 * completes the corresponding journal entry is marked committed.
 *
 * On open, {@link replay} walks the journal and reports any entries
 * still marked uncommitted — those are mutations that started but didn't
 * finish before a crash. Re-applying their effect requires the original
 * data, which the journal doesn't store in this minimal POC version
 * (data records would push the journal block size past one block);
 * callers can use the report to detect known-stale state.
 *
 * Limitations of this scaffold (POC, deliberately minimal):
 * - Journal lives in a single block at construction-time `journalBlockId`;
 *   a real WAL would chain multiple blocks.
 * - Data isn't journaled, only the metadata of (op, blockId). Full
 *   redo-from-WAL needs the bytes too.
 * - Append uses a non-atomic read-modify-write of the journal block —
 *   this matches real WAL behavior under append-only assumption but
 *   doesn't survive a crash mid-record-write. A real WAL pads to a
 *   sector boundary and writes monotonically.
 *
 * Production WAL would store data + checksum per record and chain
 * journal blocks. This class lays the API surface for that.
 */
export class KvJournaledBlockDevice extends KvBlockDevice {
    private static readonly RECORD_SIZE = 24; // see record layout below
    /** Header at journal block offset 0: a uint32 nextSeq counter. */
    private static readonly HEADER_SIZE = 4;

    private readonly inner: KvBlockDevice;
    private readonly journalBlockId: INodeId;
    /** Cached parsed records, kept in sync with the on-disk journal block. */
    private records: KvJournalRecord[] = [];
    private nextSeq = 1;

    constructor(inner: KvBlockDevice, journalBlockId: INodeId) {
        super(inner.getBlockSize(), inner.getCapacityBytes());
        this.inner = inner;
        this.journalBlockId = journalBlockId;
    }

    /**
     * Read the existing journal block and parse its records. Returns
     * any records still marked uncommitted (i.e. mutations that started
     * but didn't finish before the device was last torn down).
     *
     * Initialises the journal block lazily — if the block doesn't yet
     * exist, this is a no-op and the journal starts empty.
     */
    public async open(): Promise<KvJournalRecord[]> {
        try {
            const buffer = await this.inner.readBlock(this.journalBlockId);
            this.parseJournal(buffer);
            return this.records.filter((r) => !r.committed);
        } catch {
            // Journal block doesn't exist yet — fresh device. Start empty.
            this.records = [];
            this.nextSeq = 1;
            return [];
        }
    }

    /**
     * Initialise an empty journal block on the underlying device. Call
     * once during filesystem format. Idempotent — overwrites whatever
     * was at the journal block ID.
     */
    public async formatJournal(): Promise<void> {
        this.records = [];
        this.nextSeq = 1;
        await this.flushJournal();
    }

    /** Snapshot of currently-known journal records (read-only inspection). */
    public getRecords(): readonly KvJournalRecord[] {
        return this.records;
    }

    // ---- Block device passthrough + journaling on writes/frees ----

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        return await this.inner.readBlock(blockId);
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        const seq = await this.append('write', blockId);
        await this.inner.writeBlock(blockId, data);
        await this.markCommitted(seq);
    }

    /** Read passes through; partial reads don't mutate the device. */
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        return await this.inner.readBlockPartial(blockId, start, end);
    }

    /**
     * A partial-write is a mutation, so it journals just like a full
     * write — the record kind stays `'write'` (the POC doesn't store
     * the bytes anyway, only the fact that block N was mutated).
     */
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        const seq = await this.append('write', blockId);
        await this.inner.writeBlockPartial(blockId, offset, data);
        await this.markCommitted(seq);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        const seq = await this.append('free', blockId);
        await this.inner.freeBlock(blockId);
        await this.markCommitted(seq);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return await this.inner.existsBlock(blockId);
    }

    public async allocateBlock(): Promise<INodeId> {
        return await this.inner.allocateBlock();
    }

    public async getHighestBlockId(): Promise<INodeId> {
        return await this.inner.getHighestBlockId();
    }

    public async format(): Promise<void> {
        await this.inner.format();
        await this.formatJournal();
    }

    // ---- Journal serialization ----

    private async append(op: 'write' | 'free', blockId: INodeId): Promise<number> {
        const record: KvJournalRecord = {
            seq: this.nextSeq++,
            op,
            blockId,
            committed: false,
            timestampMs: Date.now(),
        };
        this.records.push(record);
        await this.flushJournal();
        return record.seq;
    }

    private async markCommitted(seq: number): Promise<void> {
        const record = this.records.find((r) => r.seq === seq);
        if (record) record.committed = true;
        await this.flushJournal();
    }

    /**
     * Serialize the in-memory records back to the journal block. Layout:
     * ```
     *   [0..4)              nextSeq (uint32)
     *   [4 + i*24..4+(i+1)*24)
     *                       record i:
     *     [0..4)            seq (uint32)
     *     [4..8)            blockId (uint32)
     *     [8..16)           timestampMs (uint64)
     *     [16..17)          op (0=write, 1=free)
     *     [17..18)          committed (0/1)
     *     [18..24)          reserved padding
     * ```
     * Throws KvError_BD_Overflow if the journal grows past one block —
     * the POC's hard limit. Production would chain blocks.
     */
    private async flushJournal(): Promise<void> {
        const blockSize = this.inner.getBlockSize();
        const requiredBytes = KvJournaledBlockDevice.HEADER_SIZE
            + this.records.length * KvJournaledBlockDevice.RECORD_SIZE;
        if (requiredBytes > blockSize) {
            throw new KvError_BD_Overflow(requiredBytes, blockSize);
        }

        const buffer = new Uint8Array(blockSize);
        const view = dataView(buffer);
        view.setUint32(0, this.nextSeq);

        for (let i = 0; i < this.records.length; i++) {
            const record = this.records[i];
            const off = KvJournaledBlockDevice.HEADER_SIZE
                + i * KvJournaledBlockDevice.RECORD_SIZE;
            view.setUint32(off, record.seq);
            view.setUint32(off + 4, record.blockId);
            view.setBigUint64(off + 8, BigInt(record.timestampMs));
            view.setUint8(off + 16, record.op === 'write' ? 0 : 1);
            view.setUint8(off + 17, record.committed ? 1 : 0);
        }

        await this.inner.writeBlock(this.journalBlockId, buffer);
    }

    private parseJournal(buffer: Uint8Array): void {
        const view = dataView(buffer);
        this.nextSeq = view.getUint32(0);
        if (this.nextSeq === 0) {
            this.nextSeq = 1; // virgin journal: header bytes were zero
        }

        this.records = [];
        const recordSlots = Math.floor(
            (buffer.byteLength - KvJournaledBlockDevice.HEADER_SIZE)
            / KvJournaledBlockDevice.RECORD_SIZE,
        );
        for (let i = 0; i < recordSlots; i++) {
            const off = KvJournaledBlockDevice.HEADER_SIZE
                + i * KvJournaledBlockDevice.RECORD_SIZE;
            const seq = view.getUint32(off);
            if (seq === 0) break; // empty slot — end of records
            this.records.push({
                seq,
                blockId: view.getUint32(off + 4),
                timestampMs: Number(view.getBigUint64(off + 8)),
                op: view.getUint8(off + 16) === 0 ? 'write' : 'free',
                committed: view.getUint8(off + 17) === 1,
            });
        }
    }
}
