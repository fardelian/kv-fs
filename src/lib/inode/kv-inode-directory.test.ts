import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvINodeDirectory } from './kv-inode-directory';
import { KvError_FS_NotFound, KvError_INode_NameOverflow } from '../utils';

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 1024;

// On-disk layout constants (mirrored from KvINodeDirectory so the tests
// can reason about block layout without poking at private fields).
// 24 bytes inode header (1 byte kind + 7 reserved + uint64 creation +
// uint64 modification time) + 4 bytes numEntries.
const HEADER_BYTES = 28;
// 4 bytes per-block entry count + 4 bytes next-block pointer.
const FOOTER_BYTES = 8;
const ENTRY_OVERHEAD_BYTES = 6; // 2 (uint16 length) + 4 (uint32 iNodeId)
const FIRST_BLOCK_ENTRY_AREA = BLOCK_SIZE - HEADER_BYTES - FOOTER_BYTES; // 4060
const CONTINUATION_BLOCK_ENTRY_AREA = BLOCK_SIZE - FOOTER_BYTES; // 4088

/** How many bytes a single entry consumes on disk for a name of `nameLength` UTF-8 bytes. */
function entrySize(nameLength: number): number {
    return ENTRY_OVERHEAD_BYTES + nameLength;
}

async function makeDir() {
    const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);
    const blockId = await device.allocateBlock();
    const dir = await KvINodeDirectory.createEmptyDirectory(device, blockId);
    return { device, dir, blockId };
}

async function reopen(device: KvBlockDeviceMemory, blockId: number): Promise<KvINodeDirectory> {
    return new KvINodeDirectory(device, blockId);
}

describe('KvINodeDirectory', () => {
    describe('unlink', () => {
        it('frees the inode block of an empty directory', async () => {
            const { device, dir, blockId } = await makeDir();
            expect(device._dumpBlocks().length).toBe(1);

            await dir.unlink();

            expect(await device.existsBlock(blockId)).toBe(false);
            expect(device._dumpBlocks().length).toBe(0);
        });

        it('frees both the inode and every continuation block of a chained directory', async () => {
            const { device, dir, blockId } = await makeDir();

            // Push past the first-block capacity so a continuation chain
            // exists when we unlink.
            const NAME_LENGTH = 1000;
            const longName = (i: number): string => {
                const suffix = String(i).padStart(4, '0');
                return 'x'.repeat(NAME_LENGTH - suffix.length) + suffix;
            };
            for (let i = 0; i < 8; i++) {
                await dir.addEntry(longName(i), 100 + i);
            }
            // Sanity: at least one continuation block was allocated.
            expect(device._dumpBlocks().length).toBeGreaterThan(1);

            await dir.unlink();

            expect(await device.existsBlock(blockId)).toBe(false);
            expect(device._dumpBlocks().length).toBe(0);
        });
    });

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

    describe('chaining: variable-length entries pack densely', () => {
        // Use long names so the per-block entry count is small and predictable.
        // 1000-byte name → 1006-byte entry → 4 entries fit in the first block
        // (4080 / 1006 = 4) and 4 in each continuation (4092 / 1006 = 4).
        const NAME_LENGTH = 1000;
        const ENTRIES_PER_BLOCK_FIRST = Math.floor(FIRST_BLOCK_ENTRY_AREA / entrySize(NAME_LENGTH));
        const ENTRIES_PER_BLOCK_CONT = Math.floor(CONTINUATION_BLOCK_ENTRY_AREA / entrySize(NAME_LENGTH));

        function longName(i: number): string {
            const suffix = String(i).padStart(4, '0');
            return 'x'.repeat(NAME_LENGTH - suffix.length) + suffix;
        }

        it('keeps the directory in one block when entries fit the first block', async () => {
            const { device, dir, blockId } = await makeDir();

            for (let i = 0; i < ENTRIES_PER_BLOCK_FIRST; i++) {
                await dir.addEntry(longName(i), 100 + i);
            }

            expect(device._dumpBlocks().length).toBe(1);
            expect(await device.getHighestBlockId()).toBe(blockId);
        });

        it('allocates one continuation block when entries spill past the first block', async () => {
            const { device, dir } = await makeDir();
            for (let i = 0; i < ENTRIES_PER_BLOCK_FIRST; i++) {
                await dir.addEntry(longName(i), 100 + i);
            }
            expect(device._dumpBlocks().length).toBe(1);

            await dir.addEntry(longName(ENTRIES_PER_BLOCK_FIRST), 200);

            expect(device._dumpBlocks().length).toBe(2);
        });

        it('grows the chain in step with the entry count', async () => {
            const { device, dir } = await makeDir();

            const cases = [
                { entries: 0, blocks: 1 },
                { entries: ENTRIES_PER_BLOCK_FIRST, blocks: 1 },
                { entries: ENTRIES_PER_BLOCK_FIRST + 1, blocks: 2 },
                { entries: ENTRIES_PER_BLOCK_FIRST + ENTRIES_PER_BLOCK_CONT, blocks: 2 },
                { entries: ENTRIES_PER_BLOCK_FIRST + ENTRIES_PER_BLOCK_CONT + 1, blocks: 3 },
                { entries: ENTRIES_PER_BLOCK_FIRST + 4 * ENTRIES_PER_BLOCK_CONT, blocks: 5 },
            ];

            let added = 0;
            for (const { entries, blocks } of cases) {
                while (added < entries) {
                    await dir.addEntry(longName(added), 1000 + added);
                    added++;
                }
                expect(device._dumpBlocks().length).toBe(blocks);
            }
        });

        it('frees continuation blocks when entries are removed back below the threshold', async () => {
            const { device, dir } = await makeDir();

            const totalEntries = ENTRIES_PER_BLOCK_FIRST + 2 * ENTRIES_PER_BLOCK_CONT + 1;
            for (let i = 0; i < totalEntries; i++) {
                await dir.addEntry(longName(i), 1000 + i);
            }
            // Inode + 3 continuation blocks (the +1 entry forces a third
            // continuation that holds a single entry).
            expect(device._dumpBlocks().length).toBe(4);

            for (let i = ENTRIES_PER_BLOCK_FIRST; i < totalEntries; i++) {
                await dir.removeEntry(longName(i));
            }

            expect(device._dumpBlocks().length).toBe(1);
        });
    });

    describe('chaining: short names pack many per block', () => {
        // With short names the per-block density is much higher; we focus on
        // total round-trip rather than exact block counts.
        it('round-trips 200 short-named entries', async () => {
            const { device, dir, blockId } = await makeDir();
            const total = 200;

            for (let i = 0; i < total; i++) {
                await dir.addEntry(`f${String(i).padStart(3, '0')}.txt`, 100 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(total);
            for (let i = 0; i < total; i++) {
                expect(entries.get(`f${String(i).padStart(3, '0')}.txt`)).toBe(100 + i);
            }
        });
    });

    describe('chaining: persistence across re-init', () => {
        const NAME_LENGTH = 1000;

        function longName(i: number): string {
            const suffix = String(i).padStart(4, '0');
            return 'x'.repeat(NAME_LENGTH - suffix.length) + suffix;
        }

        it('round-trips a single-block directory', async () => {
            const { device, dir, blockId } = await makeDir();
            const fitInOneBlock = Math.floor(FIRST_BLOCK_ENTRY_AREA / entrySize(NAME_LENGTH));

            for (let i = 0; i < fitInOneBlock; i++) {
                await dir.addEntry(longName(i), 100 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(fitInOneBlock);
            for (let i = 0; i < fitInOneBlock; i++) {
                expect(entries.get(longName(i))).toBe(100 + i);
            }
        });

        it('round-trips a multi-block directory (entries span 4 blocks)', async () => {
            const { device, dir, blockId } = await makeDir();
            const totalEntries = 13; // > 4 blocks at 1000-byte names (4 + 4 + 4 + 1 = 4 blocks)

            for (let i = 0; i < totalEntries; i++) {
                await dir.addEntry(longName(i), 1000 + i);
            }
            expect(device._dumpBlocks().length).toBe(4);

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(totalEntries);
            for (let i = 0; i < totalEntries; i++) {
                expect(entries.get(longName(i))).toBe(1000 + i);
            }
        });

        it('round-trips a directory after entries are added, removed, and re-added', async () => {
            const { device, dir, blockId } = await makeDir();

            // Grow to 12 entries (3 blocks at 1000-byte names).
            for (let i = 0; i < 12; i++) {
                await dir.addEntry(longName(i), 2000 + i);
            }
            // Remove the middle 6 entries.
            for (let i = 3; i < 9; i++) {
                await dir.removeEntry(longName(i));
            }
            // Add 4 fresh entries with new IDs.
            for (let i = 0; i < 4; i++) {
                await dir.addEntry(longName(100 + i), 9000 + i);
            }

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            // Survivors: longName(0..2) + longName(9..11) + longName(100..103) = 10
            expect(entries.size).toBe(10);
            for (const i of [0, 1, 2, 9, 10, 11]) {
                expect(entries.get(longName(i))).toBe(2000 + i);
            }
            for (let i = 0; i < 4; i++) {
                expect(entries.get(longName(100 + i))).toBe(9000 + i);
            }
            for (let i = 3; i < 9; i++) {
                expect(entries.has(longName(i))).toBe(false);
            }
        });

        it('round-trips an empty directory after entries are removed', async () => {
            const { device, dir, blockId } = await makeDir();
            for (let i = 0; i < 8; i++) {
                await dir.addEntry(longName(i), 100 + i);
            }
            for (let i = 0; i < 8; i++) {
                await dir.removeEntry(longName(i));
            }

            const reopened = await reopen(device, blockId);

            expect(await reopened.read()).toEqual(new Map());
            expect(device._dumpBlocks().length).toBe(1);
        });

        it('a freshly-reopened directory can be mutated further (chain bookkeeping survives)', async () => {
            const { device, dir, blockId } = await makeDir();
            for (let i = 0; i < 8; i++) { // 8 entries at 1000 bytes → 2 blocks
                await dir.addEntry(longName(i), 100 + i);
            }
            const blocksBefore = device._dumpBlocks().length;

            // Reopen and shrink — the new instance must discover the existing
            // continuation chain via init() so it can free unused blocks
            // instead of leaking them.
            const reopened = await reopen(device, blockId);
            for (let i = 4; i < 8; i++) {
                await reopened.removeEntry(longName(i));
            }

            expect(blocksBefore).toBe(2);
            expect(device._dumpBlocks().length).toBe(1);
        });
    });

    describe('name validation', () => {
        it('rejects names whose UTF-8 byte length exceeds the 16-bit MAX_NAME_LENGTH', async () => {
            // We need a block big enough that the per-block fits-check would
            // *not* fire first — so the MAX_NAME_LENGTH check is the one to
            // throw. With a 70 KiB block, a 65 KiB name fits dimensionally
            // but exceeds the uint16 length limit.
            const BIG_BLOCK = 70 * 1024;
            const device = new KvBlockDeviceMemory(BIG_BLOCK, BIG_BLOCK * 4);
            const blockId = await device.allocateBlock();
            const dir = await KvINodeDirectory.createEmptyDirectory(device, blockId);

            const tooLong = 'a'.repeat(KvINodeDirectory.MAX_NAME_LENGTH + 1);

            await expect(dir.addEntry(tooLong, 1)).rejects.toThrow(KvError_INode_NameOverflow);
        });

        it('rejects names whose entry size exceeds a single block', async () => {
            const { dir } = await makeDir();
            // The hard cap is `continuationEntryArea - ENTRY_OVERHEAD_BYTES`
            // = 4086 bytes. One byte over is unambiguously rejected.
            const tooLong = 'a'.repeat(CONTINUATION_BLOCK_ENTRY_AREA - ENTRY_OVERHEAD_BYTES + 1);

            await expect(dir.addEntry(tooLong, 1)).rejects.toThrow(KvError_INode_NameOverflow);
        });

        it('accepts a name that exactly fills a continuation block', async () => {
            const { device, dir, blockId } = await makeDir();
            const max = 'b'.repeat(CONTINUATION_BLOCK_ENTRY_AREA - ENTRY_OVERHEAD_BYTES);

            await dir.addEntry(max, 7);

            const reopened = await reopen(device, blockId);
            expect(await reopened.getEntry(max)).toBe(7);
        });

        it('accepts a 1024-byte name (well past the old 8-bit limit)', async () => {
            const { device, dir, blockId } = await makeDir();
            const name = 'c'.repeat(1024);

            await dir.addEntry(name, 11);

            const reopened = await reopen(device, blockId);
            expect(await reopened.getEntry(name)).toBe(11);
        });

        it('measures name length in UTF-8 bytes, not characters', async () => {
            const { device, dir, blockId } = await makeDir();
            // "é" is 2 UTF-8 bytes; 600 of them = 1200 bytes — well past
            // 8-bit but trivially within the 16-bit limit.
            const name = 'é'.repeat(600);

            await dir.addEntry(name, 13);

            const reopened = await reopen(device, blockId);
            expect(await reopened.getEntry(name)).toBe(13);
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

    describe('chain integrity: bulk write', () => {
        it('a single bulk write growing the chain by 3 blocks allocates distinct IDs (no slot collision)', async () => {
            const { device, dir, blockId } = await makeDir();

            // Use 1000-byte names so 4 entries fit per block, requiring
            // continuations to hold 13 entries (4 + 4 + 4 + 1 = 4 blocks).
            const NAME_LENGTH = 1000;
            const longName = (i: number): string => {
                const suffix = String(i).padStart(4, '0');
                return 'x'.repeat(NAME_LENGTH - suffix.length) + suffix;
            };

            const bulk = new Map<string, number>();
            for (let i = 0; i < 13; i++) {
                bulk.set(longName(i), 8000 + i);
            }

            // Single write() that grows the chain by 3 continuation blocks
            // in one shot. Without slot-claiming, sequential allocateBlock
            // calls would return the same ID repeatedly and entries would
            // collapse onto one block.
            await dir.write(bulk);

            expect(device._dumpBlocks().length).toBe(4);

            const reopened = await reopen(device, blockId);
            const entries = await reopened.read();

            expect(entries.size).toBe(13);
            for (let i = 0; i < 13; i++) {
                expect(entries.get(longName(i))).toBe(8000 + i);
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
            const names = Array.from(entries.keys());
            const expectedNames = Array.from(expected.keys());
            expect(names).toEqual(expectedNames);
        });
    });
});
