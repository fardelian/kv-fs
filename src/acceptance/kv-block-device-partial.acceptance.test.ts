import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionRot13 } from '../lib/encryption';

// Realistic block size — these are end-to-end-ish acceptance tests, not
// edge-case unit tests (those live under helpers/).
const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 16;
const CAPACITY_BYTES = BLOCK_SIZE * TOTAL_BLOCKS;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build a block whose bytes follow `byte[i] = (blockId * blockSize + i) & 0xff`. */
function patternBlock(blockId: number): Uint8Array {
    const block = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
        block[i] = (blockId * BLOCK_SIZE + i) & 0xff;
    }
    return block;
}

async function fillDevice(device: KvBlockDeviceMemory): Promise<void> {
    for (let blockId = 0; blockId < TOTAL_BLOCKS; blockId++) {
        await device.writeBlock(blockId, patternBlock(blockId));
    }
}

/** Search every block of an in-memory device for the given byte sequence. */
function anyBlockContains(device: KvBlockDeviceMemory, needle: Uint8Array): boolean {
    for (const block of device._dumpBlocks()) {
        outer: for (let i = 0; i <= block.length - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (block[i + j] !== needle[j]) continue outer;
            }
            return true;
        }
    }
    return false;
}

describe('KvBlockDevice partial IO (acceptance)', () => {
    it('updates a struct-shaped record without touching the rest of the block', async () => {
        // Layout: [counter:Int32][payload:rest]
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        const initial = new Uint8Array(BLOCK_SIZE);
        new DataView(initial.buffer).setInt32(0, 0);
        const payload = encoder.encode(faker.lorem.paragraph());
        initial.set(payload, 4);
        await device.writeBlock(0, initial);

        // Bump the counter through writeBlockPartial; payload should be intact.
        const newCounter = new Uint8Array(4);
        new DataView(newCounter.buffer).setInt32(0, 0xdeadbeef | 0);
        await device.writeBlockPartial(0, 0, newCounter);

        // Read the counter back through readBlockPartial.
        const counterBytes = await device.readBlockPartial(0, 0, 4);
        const view = new DataView(counterBytes.buffer, counterBytes.byteOffset, counterBytes.byteLength);
        expect(view.getInt32(0)).toBe(0xdeadbeef | 0);

        // Read the payload back through readBlockPartial. Must match exactly.
        const payloadRead = await device.readBlockPartial(0, 4, 4 + payload.length);
        expect(decoder.decode(payloadRead)).toBe(decoder.decode(payload));
    });

    it('a sequence of partial updates across many blocks lands in the right places', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
        await fillDevice(device);

        // Build a parallel ground-truth as we apply each update, so the final
        // assertion compares actual vs. expected for every block.
        const expected: Uint8Array[] = [];
        for (let b = 0; b < TOTAL_BLOCKS; b++) {
            expected.push(patternBlock(b));
        }

        // A deterministic mix of full-prefix, mid-block, end-of-block, and
        // last-byte updates across a handful of blocks.
        const updates: { blockId: number; offset: number; data: Uint8Array }[] = [
            { blockId: 0, offset: 0, data: new Uint8Array([0xa0, 0xa1, 0xa2, 0xa3]) },
            { blockId: 1, offset: 100, data: new Uint8Array([0xb0]) },
            { blockId: 2, offset: BLOCK_SIZE - 1, data: new Uint8Array([0xc0]) },
            { blockId: 5, offset: BLOCK_SIZE - 32, data: new Uint8Array(32).fill(0xdd) },
            { blockId: 9, offset: 0, data: new Uint8Array(BLOCK_SIZE).fill(0xee) },
            { blockId: 0, offset: 200, data: new Uint8Array([0x10, 0x20]) },
            { blockId: 15, offset: BLOCK_SIZE - 4, data: new Uint8Array([0xfa, 0xfb, 0xfc, 0xfd]) },
        ];

        for (const { blockId, offset, data } of updates) {
            await device.writeBlockPartial(blockId, offset, data);
            expected[blockId].set(data, offset);
        }

        // Verify every block end-to-end via readBlockPartial(0, BLOCK_SIZE).
        for (let blockId = 0; blockId < TOTAL_BLOCKS; blockId++) {
            const actual = await device.readBlockPartial(blockId, 0, BLOCK_SIZE);
            expect(Array.from(actual)).toEqual(Array.from(expected[blockId]));
        }
    });

    it('partial reads recover an arbitrary byte range without reading the whole block', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
        await fillDevice(device);

        // Ten reads at varied offsets and lengths — verify each one against
        // the known pattern.
        const samples: { blockId: number; start: number; end: number }[] = [
            { blockId: 0, start: 0, end: 1 },
            { blockId: 0, start: BLOCK_SIZE - 1, end: BLOCK_SIZE },
            { blockId: 1, start: 0, end: BLOCK_SIZE },
            { blockId: 3, start: 100, end: 200 },
            { blockId: 7, start: BLOCK_SIZE / 2, end: BLOCK_SIZE / 2 + 64 },
            { blockId: 15, start: BLOCK_SIZE - 256, end: BLOCK_SIZE },
        ];

        for (const { blockId, start, end } of samples) {
            const got = await device.readBlockPartial(blockId, start, end);
            const expected: number[] = [];
            for (let i = start; i < end; i++) {
                expected.push((blockId * BLOCK_SIZE + i) & 0xff);
            }
            expect(Array.from(got)).toEqual(expected);
        }
    });

    it('partial IO is transparent through the ROT13 encryption layer', async () => {
        const underlying = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
        const encrypted = new KvEncryptedBlockDevice(underlying, new KvEncryptionRot13());

        // Initialise block 0 through the encrypted device with a benign
        // filler — this both creates the underlying ciphertext and exercises
        // the encrypt path before the partial write runs.
        const filler = new Uint8Array(BLOCK_SIZE);
        filler.fill('a'.charCodeAt(0));
        await encrypted.writeBlock(0, filler);

        // Splice a known phrase into the middle of the block.
        const plaintext = 'the quick brown fox jumps over the lazy dog';
        const ciphertext = 'gur dhvpx oebja sbk whzcf bire gur ynml qbt'; // ROT13(plaintext)
        const offset = 1000;
        await encrypted.writeBlockPartial(0, offset, encoder.encode(plaintext));

        // 1) Reading through the encrypted device must give us the plaintext
        //    back.
        const readBack = await encrypted.readBlockPartial(0, offset, offset + plaintext.length);
        expect(decoder.decode(readBack)).toBe(plaintext);

        // 2) The bytes actually stored on the underlying memory must contain
        //    the ROT13 ciphertext, not the plaintext.
        expect(anyBlockContains(underlying, encoder.encode(plaintext))).toBe(false);
        expect(anyBlockContains(underlying, encoder.encode(ciphertext))).toBe(true);

        // 3) The bytes outside the spliced range are still the rot13'd form
        //    of the original 'a' filler ('n').
        const before = await encrypted.readBlockPartial(0, 0, 10);
        for (const b of before) expect(b).toBe('a'.charCodeAt(0));
        const after = await encrypted.readBlockPartial(0, offset + plaintext.length, offset + plaintext.length + 10);
        for (const b of after) expect(b).toBe('a'.charCodeAt(0));
    });
});
