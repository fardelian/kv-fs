import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { KvEncryptedBlockDevice } from './kv-encrypted-block-device';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';
import { KvError_BD_Overflow } from '../utils';
import { KvEncryption } from '../encryption';

const INNER_BLOCK_SIZE = 256;
const INNER_CAPACITY_BYTES = INNER_BLOCK_SIZE * 16;

/**
 * A test-only `KvEncryption` that XORs every byte with `0xff`. Length-
 * preserving (overhead 0), self-inverse, completely deterministic, and
 * doesn't touch the real crypto runtime. We just need a non-trivial
 * transform to verify the wrapper is calling `encrypt` on writes and
 * `decrypt` on reads.
 */
class XorEncryption extends KvEncryption {
    public readonly overheadBytes: number;
    public readonly encrypt = jest.fn<KvEncryption['encrypt']>();
    public readonly decrypt = jest.fn<KvEncryption['decrypt']>();

    constructor(overheadBytes = 0) {
        super();
        this.overheadBytes = overheadBytes;
        this.encrypt.mockImplementation(async (_blockId, data) => {
            const out = new Uint8Array(data.length + overheadBytes);
            for (let i = 0; i < data.length; i++) out[i] = data[i] ^ 0xff;
            return out;
        });
        this.decrypt.mockImplementation(async (_blockId, data) => {
            // Mirror of encrypt — strip overhead and unxor.
            const usable = data.subarray(0, data.length - overheadBytes);
            const out = new Uint8Array(usable.length);
            for (let i = 0; i < usable.length; i++) out[i] = usable[i] ^ 0xff;
            return out;
        });
    }
}

describe('KvEncryptedBlockDevice', () => {
    describe('constructor', () => {
        it('exposes innerBlockSize - overheadBytes as the wrapped block size', () => {
            const inner = new MockBlockDevice(INNER_BLOCK_SIZE, INNER_CAPACITY_BYTES);
            const enc = new XorEncryption(32);

            const wrapped = new KvEncryptedBlockDevice(inner, enc);

            expect(wrapped.getBlockSize()).toBe(INNER_BLOCK_SIZE - 32);
        });

        it('throws when the encryption overhead leaves no room for plaintext', () => {
            const inner = new MockBlockDevice(16);
            const enc = new XorEncryption(32);

            expect(() => new KvEncryptedBlockDevice(inner, enc)).toThrow(/too small/);
        });

        it('rejects overhead exactly equal to inner block size', () => {
            const inner = new MockBlockDevice(32);
            const enc = new XorEncryption(32);

            expect(() => new KvEncryptedBlockDevice(inner, enc)).toThrow(/too small/);
        });
    });

    describe('writeBlock', () => {
        it('zero-pads plaintext to the exposed block size, encrypts, then writes to the inner device', async () => {
            const inner = new MockBlockDevice(INNER_BLOCK_SIZE, INNER_CAPACITY_BYTES);
            inner.writeBlock.mockResolvedValueOnce(undefined);
            const enc = new XorEncryption();
            const wrapped = new KvEncryptedBlockDevice(inner, enc);

            const data = new Uint8Array([1, 2, 3]);
            await wrapped.writeBlock(5, data);

            expect(enc.encrypt).toHaveBeenCalledTimes(1);
            const [encBlockId, encInput] = enc.encrypt.mock.calls[0];
            expect(encBlockId).toBe(5);
            expect(encInput.length).toBe(INNER_BLOCK_SIZE);
            expect(Array.from(encInput.subarray(0, 3))).toEqual([1, 2, 3]);
            for (let i = 3; i < INNER_BLOCK_SIZE; i++) {
                expect(encInput[i]).toBe(0);
            }

            expect(inner.writeBlock).toHaveBeenCalledTimes(1);
            const [innerBlockId, innerData] = inner.writeBlock.mock.calls[0];
            expect(innerBlockId).toBe(5);
            // After XOR with 0xff: 1→254, 2→253, 3→252, 0→255 (everywhere else).
            expect(innerData[0]).toBe(254);
            expect(innerData[1]).toBe(253);
            expect(innerData[2]).toBe(252);
            for (let i = 3; i < INNER_BLOCK_SIZE; i++) {
                expect(innerData[i]).toBe(0xff);
            }
        });

        it('throws KvError_BD_Overflow when data exceeds the exposed block size', async () => {
            const inner = new MockBlockDevice(INNER_BLOCK_SIZE, INNER_CAPACITY_BYTES);
            const enc = new XorEncryption(32);
            const wrapped = new KvEncryptedBlockDevice(inner, enc);

            const oversize = new Uint8Array(wrapped.getBlockSize() + 1);
            await expect(wrapped.writeBlock(0, oversize)).rejects.toBeInstanceOf(KvError_BD_Overflow);
            expect(enc.encrypt).not.toHaveBeenCalled();
            expect(inner.writeBlock).not.toHaveBeenCalled();
        });
    });

    describe('readBlock', () => {
        it('reads from the inner device and decrypts the bytes', async () => {
            const inner = new MockBlockDevice(INNER_BLOCK_SIZE, INNER_CAPACITY_BYTES);
            const ciphertext = new Uint8Array(INNER_BLOCK_SIZE);
            ciphertext.fill(0xff);
            ciphertext[0] = 0xfe; // 0xfe XOR 0xff = 0x01
            inner.readBlock.mockResolvedValueOnce(ciphertext);
            const enc = new XorEncryption();
            const wrapped = new KvEncryptedBlockDevice(inner, enc);

            const result = await wrapped.readBlock(2);

            expect(inner.readBlock).toHaveBeenCalledWith(2);
            expect(enc.decrypt).toHaveBeenCalledTimes(1);
            expect(result.length).toBe(INNER_BLOCK_SIZE);
            expect(result[0]).toBe(0x01);
        });
    });

    describe('passthrough operations', () => {
        let inner: MockBlockDevice;
        let wrapped: KvEncryptedBlockDevice;

        beforeEach(() => {
            inner = new MockBlockDevice(INNER_BLOCK_SIZE, INNER_CAPACITY_BYTES);
            wrapped = new KvEncryptedBlockDevice(inner, new XorEncryption());
        });

        it('freeBlock delegates to the inner device', async () => {
            inner.freeBlock.mockResolvedValueOnce(undefined);

            await wrapped.freeBlock(3);

            expect(inner.freeBlock).toHaveBeenCalledWith(3);
        });

        it('existsBlock delegates to the inner device', async () => {
            inner.existsBlock.mockResolvedValueOnce(true);

            expect(await wrapped.existsBlock(4)).toBe(true);
            expect(inner.existsBlock).toHaveBeenCalledWith(4);
        });

        it('allocateBlock delegates to the inner device', async () => {
            inner.allocateBlock.mockResolvedValueOnce(11);

            expect(await wrapped.allocateBlock()).toBe(11);
        });

        it('getHighestBlockId delegates to the inner device', async () => {
            inner.getHighestBlockId.mockResolvedValueOnce(8);

            expect(await wrapped.getHighestBlockId()).toBe(8);
        });

        it('format delegates to the inner device', async () => {
            inner.format.mockResolvedValueOnce(undefined);

            await wrapped.format();

            expect(inner.format).toHaveBeenCalledTimes(1);
        });
    });
});
