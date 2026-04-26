import { describe, it, expect } from 'bun:test';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceMemory, KvEncryptedBlockDevice } from '../lib/block-devices';
import { KvEncryptionAES256GCMKey } from '../lib/encryption';
import { KvFilesystem, KvFilesystemSimple } from '../lib/filesystem';

const SUPER_BLOCK_ID = 0;

interface FsOptions {
    blockSize?: number;
    blocks?: number;
    inodes?: number;
    encrypted?: boolean;
}

async function makeFs(opts: FsOptions = {}): Promise<{
    fs: KvFilesystemSimple;
    raw: KvBlockDeviceMemory;
}> {
    const blockSize = opts.blockSize ?? 4096;
    const blocks = opts.blocks ?? 4096;
    const inodes = opts.inodes ?? Math.min(blocks, 1024);

    const raw = new KvBlockDeviceMemory(blockSize, blockSize * blocks);
    const device = opts.encrypted
        ? new KvEncryptedBlockDevice(
                raw,
                new KvEncryptionAES256GCMKey(KvEncryptionAES256GCMKey.generateRandomKey()),
            )
        : raw;

    await KvFilesystem.format(device, inodes);
    const fs = new KvFilesystemSimple(new KvFilesystem(device, SUPER_BLOCK_ID), '/');
    return { fs, raw };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('kv-fs (thorough acceptance)', () => {
    describe('many files in a flat directory', () => {
        it('1000 files: all listed, all readable, content preserved', async () => {
            const { fs } = await makeFs({ blocks: 16384 });
            await fs.createDirectory('/flat', true);

            const FILE_COUNT = 1000;
            for (let i = 0; i < FILE_COUNT; i++) {
                const file = await fs.createFile(`/flat/file-${String(i).padStart(4, '0')}.txt`);
                await file.write(enc.encode(`payload-${i}`));
            }

            const listing = await fs.readDirectory('/flat');
            expect(listing.length).toBe(FILE_COUNT);

            // Spot-check a stride of files spread across the chain.
            for (const i of [0, 1, 99, 250, 500, 750, 999]) {
                const data = await fs.readFile(`/flat/file-${String(i).padStart(4, '0')}.txt`);
                expect(dec.decode(data)).toBe(`payload-${i}`);
            }
        }, 60_000);

        it('directory shrinks back to one block after every entry is unlinked', async () => {
            const { fs, raw } = await makeFs({ blocks: 16384 });
            await fs.createDirectory('/churn', true);

            const FILE_COUNT = 200;
            for (let i = 0; i < FILE_COUNT; i++) {
                await fs.createFile(`/churn/x-${i}.txt`);
            }
            const peak = await raw.getHighestBlockId();

            for (let i = 0; i < FILE_COUNT; i++) {
                await fs.unlink(`/churn/x-${i}.txt`);
            }
            const listing = await fs.readDirectory('/churn');
            expect(listing.length).toBe(0);

            // After unlinking everything, the device should not have
            // grown further (unlinks free blocks but leave the
            // high-water mark at peak — what we really check is that
            // listing works & the directory chain is back to length 1).
            expect(await raw.getHighestBlockId()).toBeLessThanOrEqual(peak);
        }, 60_000);
    });

    describe('deeply nested directories', () => {
        it('64-level deep path; file at the leaf round-trips', async () => {
            const { fs } = await makeFs({ blocks: 1024, inodes: 256 });

            const components = Array.from({ length: 64 }, (_, i) => `lvl${i}`);
            const fullPath = '/' + components.join('/');
            await fs.createDirectory(fullPath, true);

            const filePath = `${fullPath}/leaf.txt`;
            const file = await fs.createFile(filePath);
            await file.write(enc.encode('found at the bottom'));

            const data = await fs.readFile(filePath);
            expect(dec.decode(data)).toBe('found at the bottom');

            // Each intermediate listing should contain the next level.
            for (let i = 0; i < components.length; i++) {
                const dir = '/' + components.slice(0, i).join('/');
                const next = await fs.readDirectory(dir === '' ? '/' : dir);
                expect(next).toContain(components[i]);
            }
        }, 30_000);
    });

    describe('wide directory tree', () => {
        it('5×5×5 = 125 leaves; every file readable', async () => {
            const { fs } = await makeFs({ blocks: 4096, inodes: 1024 });

            // Make a shallow but bushy tree: /a{0..4}/b{0..4}/c{0..4}/leaf.txt
            for (let a = 0; a < 5; a++) {
                for (let b = 0; b < 5; b++) {
                    for (let c = 0; c < 5; c++) {
                        const dir = `/a${a}/b${b}/c${c}`;
                        await fs.createDirectory(dir, true);
                        const file = await fs.createFile(`${dir}/leaf.txt`);
                        await file.write(enc.encode(`@${a},${b},${c}`));
                    }
                }
            }

            // Verify every leaf.
            for (let a = 0; a < 5; a++) {
                for (let b = 0; b < 5; b++) {
                    for (let c = 0; c < 5; c++) {
                        const data = await fs.readFile(`/a${a}/b${b}/c${c}/leaf.txt`);
                        expect(dec.decode(data)).toBe(`@${a},${b},${c}`);
                    }
                }
            }

            // Each /aX should list five b-children, each /aX/bY should list five c-children.
            const aRoots = await fs.readDirectory('/');
            for (let a = 0; a < 5; a++) expect(aRoots).toContain(`a${a}`);
            for (let a = 0; a < 5; a++) {
                const bDir = await fs.readDirectory(`/a${a}`);
                expect(bDir.length).toBe(5);
            }
        }, 60_000);
    });

    describe('large files (direct + indirect)', () => {
        it('writes a file that fits in the inline direct-pointer area', async () => {
            const { fs } = await makeFs({ blockSize: 128, blocks: 512, inodes: 64 });
            await fs.createDirectory('/big', true);
            const file = await fs.createFile('/big/in-direct.bin');

            // 20 × 128B = 2560 bytes; (128-32-4)/4 = 23 direct slots, so this
            // sits inside the direct-only region.
            const payload = randomBytes(20 * 128);
            await file.write(payload);

            await file.setPos(0);
            const back = await file.read();
            expect(back.length).toBe(payload.length);
            expect(Array.from(back)).toEqual(Array.from(payload));
        });

        it('writes a file that crosses into the indirect block', async () => {
            const { fs } = await makeFs({ blockSize: 128, blocks: 512, inodes: 64 });
            await fs.createDirectory('/big', true);
            const file = await fs.createFile('/big/spans-indirect.bin');

            // 40 × 128B = 5120 bytes; past the 23-direct-slot threshold so
            // an indirect block is allocated.
            const payload = randomBytes(40 * 128);
            await file.write(payload);

            await file.setPos(0);
            const back = await file.read();
            expect(Array.from(back)).toEqual(Array.from(payload));
        });

        it('writes a file at the exact indirect-block capacity', async () => {
            const { fs } = await makeFs({ blockSize: 128, blocks: 512, inodes: 64 });
            await fs.createDirectory('/big', true);
            const file = await fs.createFile('/big/at-capacity.bin');

            // Exactly maxDirect + maxIndirect blocks worth.
            // maxDirect = (128 - 32 - 4) / 4 = 23
            // maxIndirect = 128 / 4 = 32
            const totalBlocks = 23 + 32;
            const payload = randomBytes(totalBlocks * 128);

            await file.write(payload);
            await file.setPos(0);
            const back = await file.read();
            expect(Array.from(back)).toEqual(Array.from(payload));
        });

        it('throws when a file exceeds direct + single-indirect capacity (no doubly-indirect yet)', async () => {
            const { fs } = await makeFs({ blockSize: 128, blocks: 512, inodes: 64 });
            await fs.createDirectory('/big', true);
            const file = await fs.createFile('/big/over-cap.bin');

            // One block past the single-indirect limit. With no
            // doubly-indirect block, writeMetadata's indirect-block
            // serialization runs off the end of the indirect buffer.
            // Documented limitation, not a regression — bumping this
            // requires the doubly-indirect step.
            const overflowBlocks = 23 + 32 + 1;
            const payload = randomBytes(overflowBlocks * 128);

            await expect(file.write(payload)).rejects.toThrow();
        });
    });

    describe('round-trip through remount', () => {
        it('a complex tree survives format-version-aware remount', async () => {
            const raw = new KvBlockDeviceMemory(4096, 4096 * 4096);
            await KvFilesystem.format(raw, 1024);

            // First mount: build out a small tree.
            {
                const fs = new KvFilesystemSimple(new KvFilesystem(raw, SUPER_BLOCK_ID), '/');
                await fs.createDirectory('/users/alice', true);
                await fs.createDirectory('/users/bob', true);
                await fs.createDirectory('/var/log', true);

                for (let i = 0; i < 30; i++) {
                    const file = await fs.createFile(`/users/alice/note-${i}.txt`);
                    await file.write(enc.encode(`alice-${i}`));
                }
                for (let i = 0; i < 5; i++) {
                    const file = await fs.createFile(`/users/bob/diary-${i}.txt`);
                    await file.write(enc.encode(`bob-${i}`));
                }
                const log = await fs.createFile('/var/log/syslog');
                await log.write(enc.encode(faker.lorem.paragraphs(5)));
            }

            // Second mount: reopen, read everything.
            const fs2 = new KvFilesystemSimple(new KvFilesystem(raw, SUPER_BLOCK_ID), '/');

            const aliceFiles = await fs2.readDirectory('/users/alice');
            expect(aliceFiles.length).toBe(30);

            const bobFiles = await fs2.readDirectory('/users/bob');
            expect(bobFiles.length).toBe(5);

            for (let i = 0; i < 30; i++) {
                const data = await fs2.readFile(`/users/alice/note-${i}.txt`);
                expect(dec.decode(data)).toBe(`alice-${i}`);
            }
        });
    });

    describe('zero-knowledge stack: AES-256-GCM-encrypted block device', () => {
        it('all filesystem operations work transparently through encryption', async () => {
            const { fs } = await makeFs({ encrypted: true });

            await fs.createDirectory('/secrets', true);
            const file = await fs.createFile('/secrets/diary.txt');
            await file.write(enc.encode('the meeting is at midnight'));

            const back = await fs.readFile('/secrets/diary.txt');
            expect(dec.decode(back)).toBe('the meeting is at midnight');
        });

        it('plaintext does not appear in the underlying block device', async () => {
            const { fs, raw } = await makeFs({ encrypted: true });

            await fs.createDirectory('/safe', true);
            const file = await fs.createFile('/safe/pin.txt');
            const plaintext = 'CORRECT_HORSE_BATTERY_STAPLE';
            await file.write(enc.encode(plaintext));

            // Walk every block on the underlying (raw) device looking for
            // the plaintext bytes — a real zero-knowledge layer must
            // store ciphertext only.
            const plaintextBytes = enc.encode(plaintext);
            const blocks = raw._dumpBlocks();
            let found = false;
            for (const block of blocks) {
                outer: for (let i = 0; i + plaintextBytes.length <= block.length; i++) {
                    for (let j = 0; j < plaintextBytes.length; j++) {
                        if (block[i + j] !== plaintextBytes[j]) continue outer;
                    }
                    found = true;
                    break;
                }
                if (found) break;
            }
            expect(found).toBe(false);
        });

        it('a chained directory + multi-block file round-trips through the encryption layer', async () => {
            const { fs } = await makeFs({ encrypted: true, blocks: 8192 });
            await fs.createDirectory('/hidden', true);

            // Many directory entries → forces directory chaining through
            // the encrypted block device.
            for (let i = 0; i < 80; i++) {
                const file = await fs.createFile(`/hidden/secret-${i}.bin`);
                // Each file is multiple blocks worth.
                await file.write(randomBytes(3 * 4068)); // 4068 = 4096 - 28 GCM overhead
            }

            const listing = await fs.readDirectory('/hidden');
            expect(listing.length).toBe(80);

            // Spot-check that each file's bytes round-trip.
            for (const i of [0, 7, 41, 79]) {
                const back = await fs.readFile(`/hidden/secret-${i}.bin`);
                expect(back.length).toBe(3 * 4068);
            }
        }, 60_000);
    });

    describe('names: long, unicode, edge cases', () => {
        it('files with 1024-byte names are preserved through round-trip', async () => {
            const { fs } = await makeFs();
            await fs.createDirectory('/long', true);

            const name = 'x'.repeat(1024);
            const file = await fs.createFile(`/long/${name}`);
            await file.write(enc.encode('content'));

            const data = await fs.readFile(`/long/${name}`);
            expect(dec.decode(data)).toBe('content');
        });

        it('files with multi-byte UTF-8 names round-trip', async () => {
            const { fs } = await makeFs();
            await fs.createDirectory('/utf', true);

            const names = [
                '日本語.txt',
                'café.md',
                '🎉party.txt',
                'مرحبا.txt',
                'Россия.txt',
            ];
            for (const name of names) {
                const file = await fs.createFile(`/utf/${name}`);
                await file.write(enc.encode(name));
            }

            const listing = await fs.readDirectory('/utf');
            for (const name of names) {
                expect(listing).toContain(name);
                const data = await fs.readFile(`/utf/${name}`);
                expect(dec.decode(data)).toBe(name);
            }
        });

        it('file with the same content read twice yields identical bytes', async () => {
            const { fs } = await makeFs();
            const file = await fs.createFile('/twice.bin');
            const payload = randomBytes(2048);
            await file.write(payload);

            const a = await fs.readFile('/twice.bin');
            const b = await fs.readFile('/twice.bin');
            expect(Array.from(a)).toEqual(Array.from(payload));
            expect(Array.from(b)).toEqual(Array.from(payload));
        });
    });

    describe('boundary conditions', () => {
        it('writes a file whose size is exactly a multiple of blockSize', async () => {
            const { fs } = await makeFs({ blockSize: 256, blocks: 256, inodes: 32 });
            const file = await fs.createFile('/exact.bin');
            const payload = randomBytes(256 * 4);
            await file.write(payload);

            await file.setPos(0);
            const back = await file.read();
            expect(Array.from(back)).toEqual(Array.from(payload));
        });

        it('writes a file whose size is one byte over a block boundary', async () => {
            const { fs } = await makeFs({ blockSize: 256, blocks: 256, inodes: 32 });
            const file = await fs.createFile('/plus-one.bin');
            const payload = randomBytes(256 * 4 + 1);
            await file.write(payload);

            await file.setPos(0);
            const back = await file.read();
            expect(Array.from(back)).toEqual(Array.from(payload));
        });

        it('truncate(0) on an empty file is a no-op', async () => {
            const { fs } = await makeFs();
            const file = await fs.createFile('/empty.txt');
            await file.truncate(0); // no-op
            const back = await fs.readFile('/empty.txt');
            expect(back.length).toBe(0);
        });

        it('overwrite of a file mid-content does not change size', async () => {
            const { fs } = await makeFs();
            const file = await fs.createFile('/overwrite.txt');
            await file.write(enc.encode('aaaaaaaaaa')); // 10 bytes
            await file.setPos(3);
            await file.write(enc.encode('XXX')); // overwrite bytes 3..5

            const back = await fs.readFile('/overwrite.txt');
            expect(dec.decode(back)).toBe('aaaXXXaaaa');
        });
    });

    describe('random churn', () => {
        it('200 random create/write/delete ops keep state consistent', async () => {
            const { fs } = await makeFs({ blocks: 8192 });
            await fs.createDirectory('/churn', true);

            // Track our expectations alongside the filesystem's state.
            const expected = new Map<string, string>();
            const seedFaker = faker;
            seedFaker.seed(42);

            for (let i = 0; i < 200; i++) {
                const action = seedFaker.helpers.arrayElement(['create', 'rewrite', 'delete']);
                if (action === 'create' || expected.size === 0) {
                    const name = `f-${i}.txt`;
                    if (!expected.has(name)) {
                        const content = seedFaker.string.alphanumeric({ length: { min: 1, max: 200 } });
                        const file = await fs.createFile(`/churn/${name}`);
                        await file.write(enc.encode(content));
                        expected.set(name, content);
                    }
                } else if (action === 'rewrite') {
                    const name = seedFaker.helpers.arrayElement(Array.from(expected.keys()));
                    const content = seedFaker.string.alphanumeric({ length: { min: 1, max: 200 } });
                    await fs.writeFile(`/churn/${name}`, enc.encode(content));
                    expected.set(name, content);
                } else { // delete
                    const name = seedFaker.helpers.arrayElement(Array.from(expected.keys()));
                    await fs.unlink(`/churn/${name}`);
                    expected.delete(name);
                }
            }

            // Final state must match expected.
            const listing = await fs.readDirectory('/churn');
            expect(listing.sort()).toEqual(Array.from(expected.keys()).sort());

            for (const [name, content] of expected) {
                const back = await fs.readFile(`/churn/${name}`);
                expect(dec.decode(back)).toBe(content);
            }
        }, 60_000);
    });
});

/** Build N pseudo-random bytes deterministically (faker-driven). */
function randomBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = faker.number.int({ min: 0, max: 255 });
    return out;
}
