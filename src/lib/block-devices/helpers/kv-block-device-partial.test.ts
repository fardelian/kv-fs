import { describe, it, expect, beforeEach } from 'test-globals';
import { KvBlockDeviceMemory } from '../kv-block-device-memory';

// Small block size and a handful of blocks — enough to test boundary
// behaviour without making the test inputs huge.
const BLOCK_SIZE = 16;
const TOTAL_BLOCKS = 4;
const CAPACITY_BYTES = BLOCK_SIZE * TOTAL_BLOCKS;

/**
 * Pre-fill the device so byte at device offset `o` equals `o & 0xff`.
 * That way every test can compute the expected bytes from offsets
 * alone without a parallel ground-truth buffer.
 */
async function fillDevice(device: KvBlockDeviceMemory): Promise<void> {
    for (let blockId = 0; blockId < TOTAL_BLOCKS; blockId++) {
        const block = new Uint8Array(BLOCK_SIZE);
        for (let i = 0; i < BLOCK_SIZE; i++) {
            block[i] = (blockId * BLOCK_SIZE + i) & 0xff;
        }
        await device.writeBlock(blockId, block);
    }
}

/** Bytes the pre-fill pattern produces for a block-relative range on `blockId`. */
function patternBlockRange(blockId: number, start: number, end: number): number[] {
    const length = Math.max(0, end - start);
    const out: number[] = [];
    for (let i = 0; i < length; i++) {
        out.push((blockId * BLOCK_SIZE + start + i) & 0xff);
    }
    return out;
}

/** Expected bytes of `blockId` after writing `data` at block-relative `offset`. */
function expectedBlockAfterWrite(blockId: number, offset: number, data: Uint8Array): number[] {
    const out = patternBlockRange(blockId, 0, BLOCK_SIZE);
    for (let i = 0; i < data.length; i++) {
        out[offset + i] = data[i];
    }
    return out;
}

describe('KvBlockDevice per-block partial IO (default impl on the abstract base)', () => {
    let device: KvBlockDeviceMemory;

    beforeEach(async () => {
        device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
        await fillDevice(device);
    });

    describe('readBlockPartial', () => {
        // ---- empty-range cases ---------------------------------------------

        it('returns an empty array when start === end', async () => {
            expect(Array.from(await device.readBlockPartial(0, 0, 0))).toEqual([]);
            expect(Array.from(await device.readBlockPartial(0, 7, 7))).toEqual([]);
            expect(Array.from(await device.readBlockPartial(0, BLOCK_SIZE, BLOCK_SIZE))).toEqual([]);
        });

        it('returns an empty array when start > end (no read at all — does not even hit the block)', async () => {
            // Use a never-written block ID (block 99) to verify we don't even
            // try to read it for a degenerate range.
            const empty = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
            expect(Array.from(await empty.readBlockPartial(99, 50, 30))).toEqual([]);
        });

        // ---- single-byte cases ---------------------------------------------

        it('reads the very first byte of block 0', async () => {
            expect(Array.from(await device.readBlockPartial(0, 0, 1))).toEqual([0]);
        });

        it('reads the last byte of block 0', async () => {
            const result = await device.readBlockPartial(0, BLOCK_SIZE - 1, BLOCK_SIZE);
            expect(Array.from(result)).toEqual([(BLOCK_SIZE - 1) & 0xff]);
        });

        it('reads the first byte of block 1', async () => {
            expect(Array.from(await device.readBlockPartial(1, 0, 1))).toEqual([BLOCK_SIZE & 0xff]);
        });

        it('reads the last byte of the last block', async () => {
            const result = await device.readBlockPartial(TOTAL_BLOCKS - 1, BLOCK_SIZE - 1, BLOCK_SIZE);
            expect(Array.from(result)).toEqual([(CAPACITY_BYTES - 1) & 0xff]);
        });

        // ---- whole-block cases ---------------------------------------------

        it('reads the entirety of block 0', async () => {
            const result = await device.readBlockPartial(0, 0, BLOCK_SIZE);
            expect(Array.from(result)).toEqual(patternBlockRange(0, 0, BLOCK_SIZE));
        });

        it('reads the entirety of a non-first block', async () => {
            const result = await device.readBlockPartial(2, 0, BLOCK_SIZE);
            expect(Array.from(result)).toEqual(patternBlockRange(2, 0, BLOCK_SIZE));
        });

        it('reads from each block in turn (verifies blockId is honoured)', async () => {
            for (let b = 0; b < TOTAL_BLOCKS; b++) {
                const result = await device.readBlockPartial(b, 0, BLOCK_SIZE);
                expect(Array.from(result)).toEqual(patternBlockRange(b, 0, BLOCK_SIZE));
            }
        });

        // ---- within a single block ----------------------------------------

        it('reads a slice from the middle of a block', async () => {
            const result = await device.readBlockPartial(0, 3, 10);
            expect(Array.from(result)).toEqual(patternBlockRange(0, 3, 10));
        });

        it('reads a slice that ends exactly on the block boundary', async () => {
            const result = await device.readBlockPartial(1, 5, BLOCK_SIZE);
            expect(Array.from(result)).toEqual(patternBlockRange(1, 5, BLOCK_SIZE));
        });

        it('reads a slice that starts exactly at offset 0', async () => {
            const result = await device.readBlockPartial(1, 0, 5);
            expect(Array.from(result)).toEqual(patternBlockRange(1, 0, 5));
        });

        // ---- out-of-bounds cases (Uint8Array.slice clamps) ----------------

        it('clamps end to blockSize when end > blockSize (one byte past the block)', async () => {
            // slice(start, end) is documented to clamp `end` to length, so
            // [0, blockSize+1) returns the whole block.
            const result = await device.readBlockPartial(0, 0, BLOCK_SIZE + 1);
            expect(Array.from(result)).toEqual(patternBlockRange(0, 0, BLOCK_SIZE));
        });

        it('clamps end to blockSize when end is way past the block', async () => {
            const result = await device.readBlockPartial(0, BLOCK_SIZE - 3, BLOCK_SIZE * 100);
            expect(Array.from(result)).toEqual(patternBlockRange(0, BLOCK_SIZE - 3, BLOCK_SIZE));
        });

        it('returns empty when the range starts at or past the block end', async () => {
            // slice(blockSize, blockSize) → empty
            expect(Array.from(await device.readBlockPartial(0, BLOCK_SIZE, BLOCK_SIZE))).toEqual([]);
            // slice(blockSize + 5, blockSize + 10) → empty after clamping
            expect(Array.from(await device.readBlockPartial(0, BLOCK_SIZE + 5, BLOCK_SIZE + 10))).toEqual([]);
        });

        it('treats negative start as offset-from-end via Uint8Array.slice semantics', async () => {
            // slice(-3, blockSize) → equivalent to slice(blockSize - 3, blockSize)
            const result = await device.readBlockPartial(0, -3, BLOCK_SIZE);
            expect(Array.from(result)).toEqual(patternBlockRange(0, BLOCK_SIZE - 3, BLOCK_SIZE));
        });

        // ---- error cases --------------------------------------------------

        it('propagates KvError_BD_NotFound when the block does not exist', async () => {
            const empty = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
            await expect(empty.readBlockPartial(0, 0, 5)).rejects.toThrow();
        });
    });

    describe('writeBlockPartial', () => {
        // ---- no-op cases --------------------------------------------------

        it('is a no-op for empty data', async () => {
            await device.writeBlockPartial(0, 0, new Uint8Array(0));
            const block0 = await device.readBlock(0);
            expect(Array.from(block0)).toEqual(patternBlockRange(0, 0, BLOCK_SIZE));
        });

        it('does not even touch the underlying block when data is empty', async () => {
            // A device with no blocks written: writeBlockPartial(badId, 0, empty)
            // must succeed without trying to readBlock.
            const empty = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
            await expect(empty.writeBlockPartial(99, 0, new Uint8Array(0))).resolves.toBeUndefined();
        });

        // ---- single-byte cases --------------------------------------------

        it('writes a single byte at offset 0', async () => {
            const data = new Uint8Array([0xaa]);
            await device.writeBlockPartial(0, 0, data);
            const block0 = await device.readBlock(0);
            expect(Array.from(block0)).toEqual(expectedBlockAfterWrite(0, 0, data));
        });

        it('writes a single byte at the last offset (blockSize - 1)', async () => {
            const data = new Uint8Array([0xbb]);
            await device.writeBlockPartial(0, BLOCK_SIZE - 1, data);
            const block0 = await device.readBlock(0);
            expect(Array.from(block0)).toEqual(expectedBlockAfterWrite(0, BLOCK_SIZE - 1, data));
        });

        it('writes a single byte to a non-first block (verifies blockId is honoured)', async () => {
            const data = new Uint8Array([0xcc]);
            await device.writeBlockPartial(2, 7, data);
            const block2 = await device.readBlock(2);
            expect(Array.from(block2)).toEqual(expectedBlockAfterWrite(2, 7, data));
            // Other blocks unchanged.
            expect(Array.from(await device.readBlock(0))).toEqual(patternBlockRange(0, 0, BLOCK_SIZE));
            expect(Array.from(await device.readBlock(1))).toEqual(patternBlockRange(1, 0, BLOCK_SIZE));
            expect(Array.from(await device.readBlock(3))).toEqual(patternBlockRange(3, 0, BLOCK_SIZE));
        });

        // ---- partial within a block ---------------------------------------

        it('writes a slice in the middle of a block, preserving the surrounding bytes', async () => {
            const data = new Uint8Array([0x10, 0x11, 0x12, 0x13, 0x14]);
            await device.writeBlockPartial(0, 3, data);
            const block0 = await device.readBlock(0);
            expect(Array.from(block0)).toEqual(expectedBlockAfterWrite(0, 3, data));
        });

        it('writes a slice ending exactly at the block boundary (offset + len === blockSize)', async () => {
            const data = new Uint8Array([0x80, 0x81, 0x82, 0x83, 0x84]);
            await device.writeBlockPartial(1, BLOCK_SIZE - data.length, data);
            const block1 = await device.readBlock(1);
            expect(Array.from(block1)).toEqual(expectedBlockAfterWrite(1, BLOCK_SIZE - data.length, data));
        });

        it('overwrites the full block when offset === 0 and data.length === blockSize', async () => {
            const data = new Uint8Array(BLOCK_SIZE);
            for (let i = 0; i < BLOCK_SIZE; i++) data[i] = 0xe0 + (i & 0x0f);
            await device.writeBlockPartial(2, 0, data);
            const block2 = await device.readBlock(2);
            expect(Array.from(block2)).toEqual(Array.from(data));
            // Adjacent blocks unchanged.
            expect(Array.from(await device.readBlock(1))).toEqual(patternBlockRange(1, 0, BLOCK_SIZE));
            expect(Array.from(await device.readBlock(3))).toEqual(patternBlockRange(3, 0, BLOCK_SIZE));
        });

        // ---- out-of-bounds cases (Uint8Array.set throws) ------------------

        it('throws when offset + data.length > blockSize (1 byte past the end)', async () => {
            const data = new Uint8Array([0x00, 0x01]);
            await expect(device.writeBlockPartial(0, BLOCK_SIZE - 1, data)).rejects.toThrow();
        });

        it('throws when offset is way past the block end', async () => {
            const data = new Uint8Array([0xff]);
            await expect(device.writeBlockPartial(0, BLOCK_SIZE + 5, data)).rejects.toThrow();
        });

        it('throws when offset is negative', async () => {
            const data = new Uint8Array([0xff]);
            await expect(device.writeBlockPartial(0, -1, data)).rejects.toThrow();
        });

        // ---- error case ---------------------------------------------------

        it('propagates KvError_BD_NotFound when the block does not exist', async () => {
            const empty = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
            await expect(empty.writeBlockPartial(0, 0, new Uint8Array([0x01]))).rejects.toThrow();
        });
    });

    describe('readBlockPartial / writeBlockPartial round-trip', () => {
        it('reads back exactly what writeBlockPartial wrote', async () => {
            const data = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
            await device.writeBlockPartial(1, 4, data);
            const read = await device.readBlockPartial(1, 4, 4 + data.length);
            expect(Array.from(read)).toEqual(Array.from(data));
        });

        it('multiple writeBlockPartials to the same block compose correctly', async () => {
            await device.writeBlockPartial(0, 0, new Uint8Array([0xa0]));
            await device.writeBlockPartial(0, BLOCK_SIZE - 1, new Uint8Array([0xb0]));
            await device.writeBlockPartial(0, 5, new Uint8Array([0xc0, 0xc1, 0xc2]));

            const expected = patternBlockRange(0, 0, BLOCK_SIZE);
            expected[0] = 0xa0;
            expected[BLOCK_SIZE - 1] = 0xb0;
            expected[5] = 0xc0;
            expected[6] = 0xc1;
            expected[7] = 0xc2;

            expect(Array.from(await device.readBlock(0))).toEqual(expected);
        });
    });
});
