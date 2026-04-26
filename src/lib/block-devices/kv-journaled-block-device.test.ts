import { describe, it, expect, beforeEach } from 'bun:test';
import { KvBlockDeviceMemory } from './kv-block-device-memory';
import { KvJournaledBlockDevice } from './kv-journaled-block-device';
import { KvError_BD_Overflow } from '../utils';

const BLOCK_SIZE = 256;
const CAPACITY = BLOCK_SIZE * 64;
const JOURNAL_BLOCK_ID = 0;

describe('KvJournaledBlockDevice (CAS / WAL scaffold)', () => {
    let inner: KvBlockDeviceMemory;
    let journaled: KvJournaledBlockDevice;

    beforeEach(async () => {
        inner = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY);
        journaled = new KvJournaledBlockDevice(inner, JOURNAL_BLOCK_ID);
        await journaled.formatJournal();
    });

    describe('append + commit', () => {
        it('appends a record on writeBlock and marks it committed once the inner write completes', async () => {
            await journaled.writeBlock(7, new Uint8Array(BLOCK_SIZE).fill(0x42));

            const records = journaled.getRecords();
            expect(records.length).toBe(1);
            expect(records[0]).toMatchObject({ seq: 1, op: 'write', blockId: 7, committed: true });
        });

        it('appends and commits a free record', async () => {
            await journaled.writeBlock(3, new Uint8Array(BLOCK_SIZE));
            await journaled.freeBlock(3);

            const records = journaled.getRecords();
            expect(records.length).toBe(2);
            expect(records[1]).toMatchObject({ op: 'free', blockId: 3, committed: true });
        });

        it('assigns monotonically-increasing sequence numbers', async () => {
            for (let i = 1; i <= 4; i++) {
                await journaled.writeBlock(i, new Uint8Array(BLOCK_SIZE));
            }
            const seqs = journaled.getRecords().map((r) => r.seq);
            expect(seqs).toEqual([1, 2, 3, 4]);
        });
    });

    describe('persistence and replay', () => {
        it('a fresh wrapper over the same journal block reports no uncommitted records on a clean shutdown', async () => {
            await journaled.writeBlock(2, new Uint8Array(BLOCK_SIZE).fill(0x01));
            await journaled.writeBlock(3, new Uint8Array(BLOCK_SIZE).fill(0x02));

            const reopened = new KvJournaledBlockDevice(inner, JOURNAL_BLOCK_ID);
            const uncommitted = await reopened.open();

            expect(uncommitted).toEqual([]);
            expect(reopened.getRecords().length).toBe(2);
        });

        it('preserves nextSeq across reopen so new appends do not clash with old', async () => {
            for (let i = 1; i <= 3; i++) {
                await journaled.writeBlock(i, new Uint8Array(BLOCK_SIZE));
            }

            const reopened = new KvJournaledBlockDevice(inner, JOURNAL_BLOCK_ID);
            await reopened.open();
            await reopened.writeBlock(99, new Uint8Array(BLOCK_SIZE));

            expect(reopened.getRecords().map((r) => r.seq)).toEqual([1, 2, 3, 4]);
        });
    });

    describe('format', () => {
        it('formatJournal clears the records but leaves the underlying device intact', async () => {
            await journaled.writeBlock(5, new Uint8Array(BLOCK_SIZE).fill(0xff));

            await journaled.formatJournal();

            expect(journaled.getRecords()).toEqual([]);
            // The underlying block 5 still exists (only the journal was wiped).
            expect(await inner.existsBlock(5)).toBe(true);
        });

        it('format wipes both the underlying device and the journal', async () => {
            await journaled.writeBlock(5, new Uint8Array(BLOCK_SIZE));

            await journaled.format();

            expect(journaled.getRecords()).toEqual([]);
            expect(await inner.existsBlock(5)).toBe(false);
        });
    });

    describe('passthroughs', () => {
        it('readBlock / existsBlock / allocateBlock / getHighestBlockId go straight to the inner device', async () => {
            const writePromise = journaled.writeBlock(1, new Uint8Array(BLOCK_SIZE).fill(7));
            await writePromise;

            const allocated = await journaled.allocateBlock();
            const block = await journaled.readBlock(1);
            const exists = await journaled.existsBlock(1);
            const highest = await journaled.getHighestBlockId();

            expect(allocated).toBeGreaterThanOrEqual(0);
            expect(block[0]).toBe(7);
            expect(exists).toBe(true);
            expect(highest).toBeGreaterThanOrEqual(1);
        });
    });

    describe('overflow protection', () => {
        it('throws when the journal would exceed one block', async () => {
            // RECORD_SIZE = 24, HEADER = 4. With 256-byte blocks: 10 record slots.
            for (let i = 0; i < 10; i++) {
                await journaled.writeBlock(i + 1, new Uint8Array(BLOCK_SIZE));
            }
            await expect(journaled.writeBlock(11, new Uint8Array(BLOCK_SIZE)))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });
    });

    describe('partial-read passes through without journaling', () => {
        it('returns the inner partial slice and leaves the journal untouched', async () => {
            await journaled.writeBlock(4, new Uint8Array(BLOCK_SIZE).fill(0x33));
            const recordsBefore = journaled.getRecords().length;

            const slice = await journaled.readBlockPartial(4, 10, 14);

            expect(Array.from(slice)).toEqual([0x33, 0x33, 0x33, 0x33]);
            // No new record — partial-read isn't a mutation.
            expect(journaled.getRecords().length).toBe(recordsBefore);
        });
    });

    describe('partial-write journals as a write', () => {
        it('appends a write record and commits it once the inner partial-write completes', async () => {
            await journaled.writeBlock(2, new Uint8Array(BLOCK_SIZE));
            const recordsBefore = journaled.getRecords().length;

            await journaled.writeBlockPartial(2, 10, new Uint8Array([0xab, 0xcd]));

            const recordsAfter = journaled.getRecords();
            expect(recordsAfter.length).toBe(recordsBefore + 1);
            expect(recordsAfter[recordsAfter.length - 1]).toMatchObject({
                op: 'write',
                blockId: 2,
                committed: true,
            });
            // The splice landed on the inner device.
            const block = await inner.readBlock(2);
            expect(block[10]).toBe(0xab);
            expect(block[11]).toBe(0xcd);
        });
    });
});
