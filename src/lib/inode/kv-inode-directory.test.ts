import { describe, it, expect } from '@jest/globals';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvINodeDirectory } from './kv-inode-directory';
import { KvError_FS_NotFound, KvError_INode_NameOverflow } from '../utils';

// 4 KiB blocks: first block fits floor((4096 - 12 - 4) / 268) = 15 entries;
// every continuation block fits floor((4096 - 4) / 268) = 15 entries.
const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 1024;
const FIRST_BLOCK_CAPACITY = 15;
const CONTINUATION_BLOCK_CAPACITY = 15;

async function makeDir() {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
    const blockId = await device.allocateBlock();
    const dir = await KvINodeDirectory.createEmptyDirectory(device, blockId);
    return { device, dir, blockId };
}

/** Re-instantiate a directory from its block ID so init() runs against the persisted bytes. */
async function reopen(device: KvBlockDeviceMemory, blockId: number): Promise<KvINodeDirectory> {
    return new KvINodeDirectory(device, blockId);
}

describe('KvINodeDirectory', () => {
    describe('basic operations', () => {
        it('starts empty', async () => {
            const { dir } = await makeDir();

            expect(await dir.read()).toEqual(new Map());
        });

        it('addEntry persists a single mapping', async () => {
            const { dir } = await makeDir();

            await dir.addEntry('foo.txt', 42);

            expect(await dir.getEntry('foo.txt')).toBe(42);
            expect(await dir.hasEntry('foo.txt')).toBe(true);
        });

        it('hasEntry returns false for unknown names', async () => {
            const { dir } = await makeDir();

            expect(await dir.hasEntry('missing')).toBe(false);
        });

        it('getEntry throws KvError_FS_NotFound for unknown names', async () => {
            const { dir } = await makeDir();

            await expect(dir.getEntry('missing')).rejects.toThrow(KvError_FS_NotFound);
        });

        it('removeEntry deletes a mapping', async () => {
            const { dir } = await makeDir();
            await dir.addEntry('foo.txt', 42);

            await dir.removeEntry('foo.txt');

            expect(await dir.hasEntry('foo.txt')).toBe(false);
            await expect(dir.getEntry('foo.txt')).rejects.toThrow(KvError_FS_NotFound);
        });
    });

    describe('chaining: block allocation', () => {
        it('keeps the directory in one block when entry count fits the first block', async () => {
            const { device, dir, blockId } = await makeDir();

            for (let i = 0; i < FIRST_BLOCK_CAPACITY; i++) {
                await dir.addEntry(`f${i}.txt`, 100 + i);
            }

            // Only the inode block itself is allocated — no continuation blocks.
            expect(device._dumpBlocks().length).toBe(1);
            expect(await device.getHighestBlockId()).toBe(blockId);
        });

        it('allocates one continuation block on the 16th entry', async () => {
            const { device, dir } = await makeDir();

            for (let i = 0; i < FIRST_BLOCK_CAPACITY; i++) {
                await dir.addEntry(`f${i}.txt`, 100 + i);
            }
            expect(device._dumpBlocks().length).toBe(1);

            await dir.addEntry('f15.txt', 115);

            // Inode block + one continuation block.
            expect(device._dumpBlocks().length).toBe(2);
        });

        it('grows the chain in step with the entry count', async () => {
            const { device, dir } = await makeDir();

            // After N entries, block count is 1 + ceil(max(0, N - cap1) / cap2).
            const cases = [
                { entries: 0, blocks: 1 },
                { entries: FIRST_BLOCK_CAPACITY, blocks: 1 },
                { entries: FIRST_BLOCK_CAPACITY + 1, blocks: 2 },
                { entries: FIRST_BLOCK_CAPACITY + CONTINUATION_BLOCK_CAPACITY, blocks: 2 },
                { entries: FIRST_BLOCK_CAPACITY + CONTINUATION_BLOCK_CAPACITY + 1, blocks: 3 },
                { entries: FIRST_BLOCK_CAPACITY + 4 * CONTINUATION_BLOCK_CAPACITY, blocks: 5 },
            ];

            let added = 0;
            for (const { entries, blocks } of cases) {
                while (added < entries) {
                    await dir.addEntry(`f${added}.txt`, 1000 + added);
                    added++;
                }
                expect(device._dumpBlocks().length).toBe(blocks);
            }
        });

        it('frees continuation blocks when entries are removed back below the threshold', async () => {
            const { device, dir } = await makeDir();

            const totalEntries = FIRST_BLOCK_CAPACITY + 2 * CONTINUATION_BLOCK_CAPACITY + 5; // 50 entries
            for (let i = 0; i < totalEntries; i++) {
                await dir.addEntry(`f${i}.txt`, 1000 + i);
            }
            expect(device._dumpBlocks().length).toBe(4); // 1 + ceil(35/15) = 1 + 3

            // Remove enough entries that everything fits in the first block.
            for (let i = FIRST_BLOCK_CAPACITY; i < totalEntries; i++) {
                await dir.removeEntry(`f${i}.txt`);
            }

            expect(device._dumpBlocks().length).toBe(1);
        });
    });

    describe('chaining: persistence across re-init', () => {
        it('round-trips a single-block directory', async () => {
            const { device, dir, blockId } = await makeDir();
            for (let i = 0; i < FIRST_BLOCK_CAPACITY; i++) {
                await dir.addEntry(`f${i}.txt`, 100 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(FIRST_BLOCK_CAPACITY);
            for (let i = 0; i < FIRST_BLOCK_CAPACITY; i++) {
                expect(entries.get(`f${i}.txt`)).toBe(100 + i);
            }
        });

        it('round-trips a multi-block directory (50 entries, 4 blocks total)', async () => {
            const { device, dir, blockId } = await makeDir();
            const totalEntries = 50;
            for (let i = 0; i < totalEntries; i++) {
                await dir.addEntry(`f${i}.txt`, 1000 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(totalEntries);
            for (let i = 0; i < totalEntries; i++) {
                expect(entries.get(`f${i}.txt`)).toBe(1000 + i);
            }
        });

        it('round-trips a directory after entries are added, removed, and re-added', async () => {
            const { device, dir, blockId } = await makeDir();

            // Grow well past the first block.
            for (let i = 0; i < 40; i++) {
                await dir.addEntry(`f${i}.txt`, 2000 + i);
            }
            // Remove the middle 20 entries.
            for (let i = 10; i < 30; i++) {
                await dir.removeEntry(`f${i}.txt`);
            }
            // Add 10 fresh entries with new IDs.
            for (let i = 0; i < 10; i++) {
                await dir.addEntry(`new${i}.txt`, 9000 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            // Survivors: f0..f9, f30..f39 (20), plus new0..new9 (10) → 30.
            expect(entries.size).toBe(30);
            for (let i = 0; i < 10; i++) {
                expect(entries.get(`f${i}.txt`)).toBe(2000 + i);
            }
            for (let i = 30; i < 40; i++) {
                expect(entries.get(`f${i}.txt`)).toBe(2000 + i);
            }
            for (let i = 0; i < 10; i++) {
                expect(entries.get(`new${i}.txt`)).toBe(9000 + i);
            }
            // The middle entries are gone.
            for (let i = 10; i < 30; i++) {
                expect(entries.has(`f${i}.txt`)).toBe(false);
            }
        });

        it('round-trips an empty directory after entries are removed', async () => {
            const { device, dir, blockId } = await makeDir();
            for (let i = 0; i < 20; i++) {
                await dir.addEntry(`f${i}.txt`, 100 + i);
            }
            for (let i = 0; i < 20; i++) {
                await dir.removeEntry(`f${i}.txt`);
            }

            const reopened = await reopen(device, blockId);

            expect(await reopened.read()).toEqual(new Map());
            expect(device._dumpBlocks().length).toBe(1);
        });

        it('a freshly-reopened directory can be mutated further (chain bookkeeping survives)', async () => {
            const { device, dir, blockId } = await makeDir();
            for (let i = 0; i < 30; i++) {
                await dir.addEntry(`f${i}.txt`, 100 + i);
            }
            const blocksBefore = device._dumpBlocks().length;

            // Reopen and shrink — the new instance must discover the existing
            // continuation chain via init() so it can free the unused blocks
            // instead of leaking them.
            const reopened = await reopen(device, blockId);
            for (let i = FIRST_BLOCK_CAPACITY; i < 30; i++) {
                await reopened.removeEntry(`f${i}.txt`);
            }

            expect(blocksBefore).toBe(2);
            expect(device._dumpBlocks().length).toBe(1);
        });
    });

    describe('name validation', () => {
        it('rejects names longer than 255 UTF-8 bytes', async () => {
            const { dir } = await makeDir();
            const tooLong = 'a'.repeat(256);

            await expect(dir.addEntry(tooLong, 1)).rejects.toThrow(KvError_INode_NameOverflow);
        });

        it('accepts a 255-byte name', async () => {
            const { device, dir, blockId } = await makeDir();
            const max = 'b'.repeat(255);

            await dir.addEntry(max, 7);

            const reopened = await reopen(device, blockId);
            expect(await reopened.getEntry(max)).toBe(7);
        });

        it('measures name length in UTF-8 bytes, not characters', async () => {
            const { dir } = await makeDir();
            // "é" is 2 UTF-8 bytes, so 128 of them = 256 bytes — one byte over.
            const overByOne = 'é'.repeat(128);

            await expect(dir.addEntry(overByOne, 1)).rejects.toThrow(KvError_INode_NameOverflow);
        });

        it('preserves UTF-8 multi-byte names through a round-trip', async () => {
            const { device, dir, blockId } = await makeDir();
            const names = ['日本語.txt', 'café.md', '🎉party.txt'];

            for (let i = 0; i < names.length; i++) {
                await dir.addEntry(names[i], 500 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            for (let i = 0; i < names.length; i++) {
                expect(entries.get(names[i])).toBe(500 + i);
            }
        });
    });

    describe('chain integrity: walking many blocks', () => {
        it('a single bulk write growing the chain by 3 blocks allocates distinct IDs (no slot collision)', async () => {
            const { device, dir, blockId } = await makeDir();

            const bulk = new Map<string, number>();
            for (let i = 0; i < 50; i++) {
                bulk.set(`bulk${i}.txt`, 8000 + i);
            }

            // Single write() that grows the chain by 3 continuation blocks
            // in one shot. Without slot-claiming, sequential allocateBlock
            // calls would return the same ID repeatedly and the entries
            // would all collapse into one block on disk.
            await dir.write(bulk);

            expect(device._dumpBlocks().length).toBe(4); // inode + ceil(35/15) = 3

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(50);
            for (let i = 0; i < 50; i++) {
                expect(entries.get(`bulk${i}.txt`)).toBe(8000 + i);
            }
        });

        it('reads every entry of a 100-entry directory in the original add order', async () => {
            const { device, dir, blockId } = await makeDir();
            const total = 100;
            const expected = new Map<string, number>();

            for (let i = 0; i < total; i++) {
                const name = `entry-${String(i).padStart(3, '0')}.txt`;
                expected.set(name, 7000 + i);
                await dir.addEntry(name, 7000 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(total);
            // JavaScript Maps preserve insertion order; the chain walk must
            // preserve it too (entries laid down in append order across blocks).
            const names = Array.from(entries.keys());
            const expectedNames = Array.from(expected.keys());
            expect(names).toEqual(expectedNames);
        });
    });
});
