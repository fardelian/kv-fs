import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { faker } from '@faker-js/faker';
import * as path from 'path';

// Mock `fs/promises` BEFORE the module under test is dynamically imported,
// so the implementation picks up our mocks instead of touching the real FS.
const mockReadFile = jest.fn<(p: string) => Promise<Uint8Array>>();
const mockWriteFile = jest.fn<(p: string, d: Uint8Array) => Promise<void>>();
const mockUnlink = jest.fn<(p: string) => Promise<void>>();
const mockAccess = jest.fn<(p: string) => Promise<void>>();
const mockReaddir = jest.fn<(p: string) => Promise<string[]>>();

interface FakeFd {
    read: jest.Mock<(buffer: Uint8Array, off: number, len: number, pos: number) => Promise<{ bytesRead: number; buffer: Uint8Array }>>;
    write: jest.Mock<(buffer: Uint8Array, off: number, len: number, pos: number) => Promise<{ bytesWritten: number; buffer: Uint8Array }>>;
    close: jest.Mock<() => Promise<void>>;
}
const mockOpen = jest.fn<(p: string, flags: string) => Promise<FakeFd>>();

jest.unstable_mockModule('fs/promises', () => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    unlink: mockUnlink,
    access: mockAccess,
    readdir: mockReaddir,
    open: mockOpen,
}));

// `await import` deferred to beforeAll because the project's main tsconfig
// targets es2016 (no top-level await). Type-only `typeof import(...)` is
// fine — it's erased at compile time and doesn't trigger module loading.
let KvBlockDeviceFs: typeof import('./kv-block-device-fs').KvBlockDeviceFs;
let KvError_BD_Overflow: typeof import('../utils').KvError_BD_Overflow;

beforeAll(async () => {
    ({ KvBlockDeviceFs } = await import('./kv-block-device-fs'));
    ({ KvError_BD_Overflow } = await import('../utils'));
});

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 1024;
const BASE_PATH = '/data';

/** Match the implementation's path layout exactly: `path.join(base, id) + '.txt'`. */
function blockPath(blockId: number): string {
    return path.join(BASE_PATH, blockId.toString()) + '.txt';
}

describe('KvBlockDeviceFs', () => {
    let device: InstanceType<typeof KvBlockDeviceFs>;

    beforeEach(() => {
        mockReadFile.mockReset();
        mockWriteFile.mockReset();
        mockUnlink.mockReset();
        mockAccess.mockReset();
        mockReaddir.mockReset();
        mockOpen.mockReset();
        device = new KvBlockDeviceFs(BLOCK_SIZE, CAPACITY_BYTES, BASE_PATH);
    });

    describe('readBlock', () => {
        it('reads from <basePath>/<blockId>.txt and returns the bytes verbatim', async () => {
            const expected = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
            mockReadFile.mockResolvedValueOnce(expected);

            const blockId = faker.number.int({ min: 0, max: 100 });
            const result = await device.readBlock(blockId);

            expect(mockReadFile).toHaveBeenCalledTimes(1);
            expect(mockReadFile).toHaveBeenCalledWith(blockPath(blockId));
            expect(result).toBe(expected);
        });

        it('propagates errors from fs.readFile', async () => {
            const err = new Error('ENOENT');
            mockReadFile.mockRejectedValueOnce(err);

            await expect(device.readBlock(0)).rejects.toBe(err);
        });
    });

    describe('writeBlock', () => {
        it('throws KvError_BD_Overflow when data is larger than blockSize', async () => {
            const oversize = new Uint8Array(BLOCK_SIZE + 1);

            await expect(device.writeBlock(0, oversize))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
            expect(mockWriteFile).not.toHaveBeenCalled();
        });

        it('pads short data to blockSize with zeros and writes to the constructed path', async () => {
            mockWriteFile.mockResolvedValueOnce(undefined);

            const data = new Uint8Array([1, 2, 3, 4, 5]);
            const blockId = 7;
            await device.writeBlock(blockId, data);

            expect(mockWriteFile).toHaveBeenCalledTimes(1);
            const [calledPath, calledData] = mockWriteFile.mock.calls[0];

            expect(calledPath).toBe(blockPath(blockId));
            expect(calledData.length).toBe(BLOCK_SIZE);
            expect(Array.from(calledData.subarray(0, data.length))).toEqual(Array.from(data));
            for (let i = data.length; i < BLOCK_SIZE; i++) {
                expect(calledData[i]).toBe(0);
            }
        });

        it('writes data of exactly blockSize bytes unchanged', async () => {
            mockWriteFile.mockResolvedValueOnce(undefined);

            const data = new Uint8Array(BLOCK_SIZE);
            for (let i = 0; i < BLOCK_SIZE; i++) data[i] = i & 0xff;

            await device.writeBlock(0, data);

            const [, calledData] = mockWriteFile.mock.calls[0];
            expect(Array.from(calledData)).toEqual(Array.from(data));
        });

        it('propagates errors from fs.writeFile', async () => {
            const err = new Error('EACCES');
            mockWriteFile.mockRejectedValueOnce(err);

            await expect(device.writeBlock(0, new Uint8Array([1]))).rejects.toBe(err);
        });
    });

    describe('freeBlock', () => {
        it('calls fs.unlink with the constructed path', async () => {
            mockUnlink.mockResolvedValueOnce(undefined);
            const blockId = faker.number.int({ min: 0, max: 100 });

            await device.freeBlock(blockId);

            expect(mockUnlink).toHaveBeenCalledTimes(1);
            expect(mockUnlink).toHaveBeenCalledWith(blockPath(blockId));
        });

        it('propagates errors from fs.unlink', async () => {
            const err = new Error('ENOENT');
            mockUnlink.mockRejectedValueOnce(err);

            await expect(device.freeBlock(0)).rejects.toBe(err);
        });
    });

    describe('existsBlock', () => {
        it('returns true when fs.access resolves and uses the constructed path', async () => {
            mockAccess.mockResolvedValueOnce(undefined);

            const blockId = 3;
            expect(await device.existsBlock(blockId)).toBe(true);
            expect(mockAccess).toHaveBeenCalledWith(blockPath(blockId));
        });

        it('returns false when fs.access rejects (ENOENT)', async () => {
            mockAccess.mockRejectedValueOnce(new Error('ENOENT'));

            expect(await device.existsBlock(0)).toBe(false);
        });

        it('returns false on any rejection (defensive — not just ENOENT)', async () => {
            mockAccess.mockRejectedValueOnce(new Error('EACCES'));

            expect(await device.existsBlock(0)).toBe(false);
        });
    });

    describe('allocateBlock', () => {
        // Helper: drive `fs.access` so a fixed set of paths "exist" and any
        // others reject with ENOENT.
        const accessReturning = (existingPaths: Set<string>) => {
            mockAccess.mockImplementation(async (p: string) => {
                if (!existingPaths.has(p)) {
                    throw new Error('ENOENT');
                }
            });
        };

        it('returns 0 when no blocks exist', async () => {
            accessReturning(new Set());

            expect(await device.allocateBlock()).toBe(0);
            expect(mockAccess).toHaveBeenCalledWith(blockPath(0));
        });

        it('returns the next ID after a contiguous run of existing blocks', async () => {
            accessReturning(new Set([blockPath(0), blockPath(1), blockPath(2)]));

            expect(await device.allocateBlock()).toBe(3);
            expect(mockAccess).toHaveBeenCalledTimes(4);
        });

        it('returns the lowest unused ID even when higher IDs are taken', async () => {
            accessReturning(new Set([blockPath(0), blockPath(2)]));

            expect(await device.allocateBlock()).toBe(1);
            expect(mockAccess).toHaveBeenCalledTimes(2);
        });
    });

    describe('getHighestBlockId', () => {
        it('returns -1 when readdir returns an empty list', async () => {
            mockReaddir.mockResolvedValueOnce([]);

            expect(await device.getHighestBlockId()).toBe(-1);
            expect(mockReaddir).toHaveBeenCalledWith(BASE_PATH);
        });

        it('returns -1 when no entries match the block-file pattern', async () => {
            mockReaddir.mockResolvedValueOnce(['README', '.DS_Store', 'notes.md', 'foo.txt.bak']);

            expect(await device.getHighestBlockId()).toBe(-1);
        });

        it('returns the only block ID when a single block file exists', async () => {
            mockReaddir.mockResolvedValueOnce(['42.txt']);

            expect(await device.getHighestBlockId()).toBe(42);
        });

        it('returns the maximum block ID across many block files', async () => {
            mockReaddir.mockResolvedValueOnce(['0.txt', '7.txt', '3.txt', '12.txt', '5.txt']);

            expect(await device.getHighestBlockId()).toBe(12);
        });

        it('ignores entries that do not strictly match \\d+\\.txt', async () => {
            mockReaddir.mockResolvedValueOnce([
                '0.txt', // valid
                '5.txt', // valid
                '5a.txt', // invalid: not all digits
                '5.text', // invalid: wrong extension
                '.txt', // invalid: no digits
                'foo', // invalid: not even an extension
                '99', // invalid: missing .txt
            ]);

            expect(await device.getHighestBlockId()).toBe(5);
        });
    });

    describe('format', () => {
        it('does nothing when there are no block files in the directory', async () => {
            mockReaddir.mockResolvedValueOnce(['README', '.DS_Store']);
            // unlink not pre-loaded; the test would fail if any call is made.

            await device.format();

            expect(mockUnlink).not.toHaveBeenCalled();
        });

        it('unlinks every block file in the directory', async () => {
            mockReaddir.mockResolvedValueOnce(['0.txt', '1.txt', '5.txt']);
            mockUnlink.mockResolvedValue(undefined);

            await device.format();

            expect(mockUnlink).toHaveBeenCalledTimes(3);
            expect(mockUnlink).toHaveBeenCalledWith(path.join(BASE_PATH, '0.txt'));
            expect(mockUnlink).toHaveBeenCalledWith(path.join(BASE_PATH, '1.txt'));
            expect(mockUnlink).toHaveBeenCalledWith(path.join(BASE_PATH, '5.txt'));
        });

        it('leaves non-block files alone', async () => {
            mockReaddir.mockResolvedValueOnce(['0.txt', 'README', '1.txt', '.DS_Store']);
            mockUnlink.mockResolvedValue(undefined);

            await device.format();

            const calledWith = mockUnlink.mock.calls.map(([p]) => p);
            expect(calledWith.sort()).toEqual([
                path.join(BASE_PATH, '0.txt'),
                path.join(BASE_PATH, '1.txt'),
            ]);
        });

        it('unlinks block files in parallel (Promise.all)', async () => {
            mockReaddir.mockResolvedValueOnce(['0.txt', '1.txt', '2.txt']);

            // Track call order vs resolution order: kick off unlinks before
            // any of them resolves, then resolve them all together. If the
            // implementation awaited in series we would only see one
            // pending call at a time.
            const pending: (() => void)[] = [];
            mockUnlink.mockImplementation(() => new Promise<void>((resolve) => {
                pending.push(resolve);
            }));

            const formatPromise = device.format();

            // Yield once so the implementation has a chance to schedule all
            // three unlinks before we resolve them.
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockUnlink).toHaveBeenCalledTimes(3);
            expect(pending).toHaveLength(3);
            for (const resolve of pending) resolve();

            await formatPromise;
        });
    });

    describe('readBlockPartial', () => {
        function makeFakeFd(): FakeFd {
            return {
                read: jest.fn<FakeFd['read']>(),
                write: jest.fn<FakeFd['write']>(),
                close: jest.fn<FakeFd['close']>().mockResolvedValue(undefined),
            };
        }

        it('opens for read at <basePath>/<blockId>.txt and reads only the requested range', async () => {
            const fd = makeFakeFd();
            mockOpen.mockResolvedValueOnce(fd);
            fd.read.mockImplementationOnce(async (buf) => {
                buf.set([0x10, 0x11, 0x12, 0x13]);
                return await Promise.resolve({ bytesRead: 4, buffer: buf });
            });

            const out = await device.readBlockPartial(2, 100, 104);

            expect(mockOpen).toHaveBeenCalledWith(blockPath(2), 'r');
            expect(fd.read).toHaveBeenCalledWith(expect.any(Uint8Array), 0, 4, 100);
            expect(Array.from(out)).toEqual([0x10, 0x11, 0x12, 0x13]);
            expect(fd.close).toHaveBeenCalledTimes(1);
        });

        it('returns an empty buffer when end <= start (no fd.open)', async () => {
            const out = await device.readBlockPartial(0, 5, 5);
            expect(out.length).toBe(0);
            expect(mockOpen).not.toHaveBeenCalled();
        });

        it('still closes the fd if read throws', async () => {
            const fd = makeFakeFd();
            mockOpen.mockResolvedValueOnce(fd);
            fd.read.mockRejectedValueOnce(new Error('disk gone'));

            await expect(device.readBlockPartial(0, 0, 4)).rejects.toThrow('disk gone');
            expect(fd.close).toHaveBeenCalledTimes(1);
        });
    });

    describe('writeBlockPartial', () => {
        function makeFakeFd(): FakeFd {
            return {
                read: jest.fn<FakeFd['read']>(),
                write: jest.fn<FakeFd['write']>(),
                close: jest.fn<FakeFd['close']>().mockResolvedValue(undefined),
            };
        }

        it('opens for r+ and writes the data at the requested offset', async () => {
            const fd = makeFakeFd();
            mockOpen.mockResolvedValueOnce(fd);
            fd.write.mockResolvedValueOnce({ bytesWritten: 3, buffer: new Uint8Array() });

            const data = new Uint8Array([0xa, 0xb, 0xc]);
            await device.writeBlockPartial(5, 200, data);

            expect(mockOpen).toHaveBeenCalledWith(blockPath(5), 'r+');
            expect(fd.write).toHaveBeenCalledWith(data, 0, 3, 200);
            expect(fd.close).toHaveBeenCalledTimes(1);
        });

        it('throws KvError_BD_Overflow when offset + data exceeds blockSize', async () => {
            const data = new Uint8Array(16);

            await expect(device.writeBlockPartial(0, BLOCK_SIZE - 8, data))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
            expect(mockOpen).not.toHaveBeenCalled();
        });

        it('is a no-op when data is empty (no fd.open)', async () => {
            await device.writeBlockPartial(0, 0, new Uint8Array(0));
            expect(mockOpen).not.toHaveBeenCalled();
        });

        it('still closes the fd if write throws', async () => {
            const fd = makeFakeFd();
            mockOpen.mockResolvedValueOnce(fd);
            fd.write.mockRejectedValueOnce(new Error('EIO'));

            await expect(device.writeBlockPartial(0, 0, new Uint8Array([1])))
                .rejects.toThrow('EIO');
            expect(fd.close).toHaveBeenCalledTimes(1);
        });
    });
});
