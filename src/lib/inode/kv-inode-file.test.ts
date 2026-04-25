import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvINodeFile } from './kv-inode-file';

// 1 KiB blocks leave 1004 bytes for data-block-id pointers in the inode
// (block size minus the 20-byte header), with plenty of room left if we want
// to add more metadata fields later.
const BLOCK_SIZE = 1024;
const CAPACITY_BLOCKS = 64;

async function makeFile() {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BLOCKS);
    const file = await KvINodeFile.createEmptyFile(device);
    return { device, file };
}

/** Build a Uint8Array of the given length filled with a deterministic pattern. */
function pattern(length: number, seed = 0): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        out[i] = (i + seed) & 0xff;
    }
    return out;
}

describe('KvINodeFile', () => {
    describe('getPos', () => {
        it('returns 0 on a fresh file', async () => {
            const { file } = await makeFile();

            expect(file.getPos()).toBe(0);
        });

        it('reflects the position after a write', async () => {
            const { file } = await makeFile();
            const data = pattern(13);

            await file.write(data);

            expect(file.getPos()).toBe(13);
        });

        it('reflects the position after a read', async () => {
            const { file } = await makeFile();
            await file.write(pattern(20));
            await file.setPos(5);

            await file.read(7);

            expect(file.getPos()).toBe(12);
        });

        it('reflects the position after setPos', async () => {
            const { file } = await makeFile();
            await file.write(pattern(50));

            await file.setPos(17);

            expect(file.getPos()).toBe(17);
        });
    });

    describe('setPos', () => {
        it('rejects negative positions', async () => {
            const { file } = await makeFile();

            await expect(file.setPos(-1)).rejects.toThrow();
        });

        it('within the current size just moves the pointer (no allocation)', async () => {
            const { device, file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE / 2));
            const blocksBefore = device._dumpBlocks().length;

            await file.setPos(10);

            expect(file.getPos()).toBe(10);
            expect(device._dumpBlocks().length).toBe(blocksBefore);
            expect(file.size).toBe(BLOCK_SIZE / 2);
        });

        it('to exactly EOF does not extend or allocate', async () => {
            const { device, file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE * 2));
            const blocksBefore = device._dumpBlocks().length;

            await file.setPos(BLOCK_SIZE * 2);

            expect(file.getPos()).toBe(BLOCK_SIZE * 2);
            expect(file.size).toBe(BLOCK_SIZE * 2);
            expect(device._dumpBlocks().length).toBe(blocksBefore);
        });

        it('past EOF extends the file with zero bytes (across multiple blocks)', async () => {
            const { file } = await makeFile();
            await file.write(pattern(5)); // size = 5, fits in block 0

            // setPos(3500) lands inside block 3, so the extension allocates 3
            // new data blocks (1, 2, 3). Block 0 already exists and stays as-is.
            // Block 3 is allocated in full; only its first 428 bytes are within
            // EOF.
            await file.setPos(3500);

            expect(file.getPos()).toBe(3500);
            expect(file.size).toBe(3500);

            // Bytes 5..3499 must read as zero.
            await file.setPos(5);
            const tail = await file.read();
            expect(tail.length).toBe(3495);
            for (const byte of tail) {
                expect(byte).toBe(0);
            }
        });

        it('overwrites the middle of a file (write 1536, setPos(64), write 1024)', async () => {
            const { file } = await makeFile();

            // First write: 1536 bytes spanning block 0 (full) and block 1 (partial, 512 of 1024).
            const first = pattern(1536, 0);
            await file.write(first);
            expect(file.size).toBe(1536);

            // Seek into the middle of block 0 and overwrite 1024 bytes — the
            // write straddles the block 0 / block 1 boundary (offsets
            // 64..1087, so 960 bytes in block 0 and 64 bytes in block 1).
            await file.setPos(64);
            const second = pattern(1024, 0xa0);
            await file.write(second);

            // No extension; file size is unchanged.
            expect(file.size).toBe(1536);

            await file.setPos(0);
            const all = await file.read();
            expect(all.length).toBe(1536);

            // Head: bytes 0..63 still come from `first`.
            expect(Array.from(all.subarray(0, 64))).toEqual(Array.from(first.subarray(0, 64)));
            // Middle: bytes 64..1087 were overwritten by `second`.
            expect(Array.from(all.subarray(64, 1088))).toEqual(Array.from(second));
            // Tail: bytes 1088..1535 still come from `first`.
            expect(Array.from(all.subarray(1088, 1536))).toEqual(Array.from(first.subarray(1088, 1536)));
        });
    });

    describe('truncate', () => {
        it('rejects negative lengths', async () => {
            const { file } = await makeFile();

            await expect(file.truncate(-1)).rejects.toThrow();
        });

        it('extends a file with zero bytes (covers 4 blocks)', async () => {
            const { file } = await makeFile();
            const data = pattern(10); // size = 10, fits in block 0
            await file.write(data);

            await file.truncate(BLOCK_SIZE * 4);

            await file.setPos(0);
            const all = await file.read();
            expect(all.length).toBe(BLOCK_SIZE * 4);
            // Original content preserved.
            expect(Array.from(all.subarray(0, 10))).toEqual(Array.from(data));
            // Extension is zero-filled.
            for (let i = 10; i < all.length; i++) {
                expect(all[i]).toBe(0);
            }
        });

        it('shrinks by freeing trailing data blocks', async () => {
            const { device, file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE * 5));
            const fullBlockCount = device._dumpBlocks().length;

            await file.truncate(BLOCK_SIZE);

            expect(file.size).toBe(BLOCK_SIZE);
            // 4 trailing data blocks should be freed.
            expect(device._dumpBlocks().length).toBe(fullBlockCount - 4);

            await file.setPos(0);
            const remaining = await file.read();
            expect(remaining.length).toBe(BLOCK_SIZE);
            expect(Array.from(remaining)).toEqual(Array.from(pattern(BLOCK_SIZE)));
        });

        it('does not modify the position', async () => {
            const { file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE * 4));
            await file.setPos(50);

            await file.truncate(20); // size now 20, pos still 50

            expect(file.getPos()).toBe(50);
            expect(file.size).toBe(20);
            // Reading from a position past EOF returns empty.
            const empty = await file.read();
            expect(empty.length).toBe(0);
        });

        it('shrinking and extending again reads back as zero (no leaked bytes)', async () => {
            const { file } = await makeFile();
            // Fill 3 blocks with non-zero data.
            await file.write(pattern(BLOCK_SIZE * 3, 0xa5));

            // Shrink way down, then grow back. The bytes between the new and
            // old sizes must read as zero — POSIX `ftruncate` says
            // "extended area shall appear as if it were zero-filled".
            await file.truncate(30);
            await file.truncate(BLOCK_SIZE * 3);

            await file.setPos(0);
            const all = await file.read();
            expect(all.length).toBe(BLOCK_SIZE * 3);
            // First 30 bytes survived.
            expect(Array.from(all.subarray(0, 30))).toEqual(Array.from(pattern(30, 0xa5)));
            // Bytes 30..end must all be zero.
            for (let i = 30; i < all.length; i++) {
                expect(all[i]).toBe(0);
            }
        });

        it('to 0 empties the file', async () => {
            const { device, file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE * 3));

            await file.truncate(0);

            expect(file.size).toBe(0);
            // Only the inode block should remain.
            expect(device._dumpBlocks().length).toBe(1);
            await file.setPos(0);
            const data = await file.read();
            expect(data.length).toBe(0);
        });
    });

    describe('read/write spanning multiple blocks', () => {
        it('round-trips a 4-block payload', async () => {
            const { file } = await makeFile();
            const payload = pattern(BLOCK_SIZE * 4);

            await file.write(payload);
            await file.setPos(0);
            const read = await file.read();

            expect(read.length).toBe(payload.length);
            expect(Array.from(read)).toEqual(Array.from(payload));
        });

        it('reads with length that crosses block boundaries (touches 3 blocks)', async () => {
            const { file } = await makeFile();
            const payload = pattern(BLOCK_SIZE * 5);
            await file.write(payload);

            // Read BLOCK_SIZE + 200 bytes starting BLOCK_SIZE - 100 bytes into
            // block 0: spans the tail of block 0, all of block 1, and the
            // start of block 2.
            const start = BLOCK_SIZE - 100;
            const length = BLOCK_SIZE + 200;
            await file.setPos(start);
            const slice = await file.read(length);

            expect(slice.length).toBe(length);
            expect(Array.from(slice)).toEqual(Array.from(payload.subarray(start, start + length)));
            expect(file.getPos()).toBe(start + length);
        });

        it('writes at an offset that crosses a block boundary (touches 3 blocks)', async () => {
            const { file } = await makeFile();
            await file.truncate(BLOCK_SIZE * 4);

            // Write BLOCK_SIZE + 100 bytes, starting BLOCK_SIZE - 100 into
            // block 0: tail of block 0, full block 1, head of block 2.
            const start = BLOCK_SIZE - 100;
            const inner = pattern(BLOCK_SIZE + 100, 0x10);
            await file.setPos(start);
            await file.write(inner);

            await file.setPos(0);
            const all = await file.read();
            // Bytes 0..start should be zero.
            for (let i = 0; i < start; i++) expect(all[i]).toBe(0);
            // Bytes [start, start+inner.length) should match `inner`.
            expect(Array.from(all.subarray(start, start + inner.length))).toEqual(Array.from(inner));
            // Bytes [start+inner.length, end) should be zero again.
            for (let i = start + inner.length; i < all.length; i++) expect(all[i]).toBe(0);
        });

        it('writing past EOF extends and zero-fills the gap (4 blocks affected)', async () => {
            const { file } = await makeFile();
            await file.write(pattern(8)); // size = 8

            // Seek 3 full blocks past EOF and write 12 bytes — the gap
            // [8, 3*BLOCK_SIZE) crosses 3 block boundaries and must read as
            // zero, with the payload landing in block 3.
            const seekTo = BLOCK_SIZE * 3;
            await file.setPos(seekTo);
            const tail = pattern(12, 0x55);
            await file.write(tail);

            expect(file.size).toBe(seekTo + 12);

            await file.setPos(0);
            const all = await file.read();
            expect(all.length).toBe(seekTo + 12);
            // Original 8 bytes.
            expect(Array.from(all.subarray(0, 8))).toEqual(Array.from(pattern(8)));
            // Gap is zero.
            for (let i = 8; i < seekTo; i++) expect(all[i]).toBe(0);
            // Tail payload.
            expect(Array.from(all.subarray(seekTo, seekTo + 12))).toEqual(Array.from(tail));
        });

        it('read at EOF returns an empty buffer without advancing position', async () => {
            const { file } = await makeFile();
            await file.write(pattern(BLOCK_SIZE * 3));
            // Position is now at EOF.
            const posBefore = file.getPos();

            const empty = await file.read();

            expect(empty.length).toBe(0);
            expect(file.getPos()).toBe(posBefore);
        });

        it('partial read at end returns only what is available', async () => {
            const { file } = await makeFile();
            const total = BLOCK_SIZE * 3 + 10;
            await file.write(pattern(total));
            await file.setPos(BLOCK_SIZE * 3);

            // Ask for more than what's left; only 10 bytes are available.
            const last = await file.read(faker.number.int({ min: 50, max: 1000 }));

            expect(last.length).toBe(10);
            expect(Array.from(last)).toEqual(Array.from(pattern(total).subarray(BLOCK_SIZE * 3, total)));
            expect(file.getPos()).toBe(total);
        });
    });
});
