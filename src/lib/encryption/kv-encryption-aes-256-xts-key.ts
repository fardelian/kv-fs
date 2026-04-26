import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import { concatBytes, KvError_Enc_Key } from '../utils';
import { KvEncryption } from './helpers/kv-encryption';

/**
 * AES-256-XTS — the cipher mode designed for block-addressable storage
 * (dm-crypt, FileVault, BitLocker all use XTS). Key insight: each block
 * is enciphered with the block ID as the "tweak", so:
 *
 *  - There is no IV to store anywhere.
 *  - The output is exactly the same length as the input.
 *  - Two equal plaintexts at different block IDs encrypt to different
 *    ciphertexts.
 *
 * Implemented on top of AES-256-ECB rather than `aes-256-xts` so the
 * code runs on every Node-compatible runtime — Bun's BoringSSL build
 * doesn't ship the `aes-256-xts` cipher name, but ECB is universal.
 *
 * **Plaintext length must be a multiple of the AES block size (16 bytes).**
 * Real XTS supports ciphertext stealing for partial trailing blocks; we
 * skip that here because the only caller (`KvEncryptedBlockDevice`) always
 * pads to `blockSize` before encrypting, and `blockSize` is always a
 * multiple of 16 in practice.
 *
 * The trade-off is that XTS is unauthenticated — an attacker who can
 * flip ciphertext bits will produce predictable plaintext changes. For
 * authenticated storage, use `KvEncryptionAES256GCMKey`.
 *
 * The 512-bit key is internally split into two 256-bit AES keys (the
 * data key and the tweak key); pass them concatenated as one 64-byte
 * `Uint8Array`. The two halves must differ (the IEEE P1619 standard
 * requires this).
 */
export class KvEncryptionAES256XTSKey implements KvEncryption {
    /** XTS combines two AES-256 keys; together that's 512 bits. */
    public static readonly KEY_LENGTH_BYTES = 64;

    /** AES block size — also the tweak length XTS expects. */
    private static readonly AES_BLOCK_BYTES = 16;

    /** XTS is length-preserving by construction. */
    public readonly overheadBytes = 0;

    private readonly dataKey: Uint8Array;
    private readonly tweakKey: Uint8Array;

    constructor(key: Uint8Array) {
        if (key.length !== KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES) {
            throw new KvError_Enc_Key(`Encryption key must be ${KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES * 8} bits (${KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES} bytes). Received ${key.length} bytes.`);
        }
        const half = KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES / 2;
        const dataKey = new Uint8Array(key.subarray(0, half));
        const tweakKey = new Uint8Array(key.subarray(half));
        if (timingSafeEqual(dataKey, tweakKey)) {
            throw new KvError_Enc_Key('XTS data key and tweak key must differ.');
        }
        this.dataKey = dataKey;
        this.tweakKey = tweakKey;
    }

    public async encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        return KvEncryptionAES256XTSKey.transform(this.dataKey, this.tweakKey, blockId, data, true);
    }

    public async decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        return KvEncryptionAES256XTSKey.transform(this.dataKey, this.tweakKey, blockId, data, false);
    }

    public static generateRandomKey(): Uint8Array {
        // Reroll if both halves happen to coincide — the standard forbids it.
        for (;;) {
            const key = randomBytes(KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES);
            const half = KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES / 2;
            if (!timingSafeEqual(key.subarray(0, half), key.subarray(half))) {
                return new Uint8Array(key);
            }
        }
    }

    private static transform(
        dataKey: Uint8Array,
        tweakKey: Uint8Array,
        sectorNumber: number,
        input: Uint8Array,
        encryptMode: boolean,
    ): Uint8Array {
        const blockBytes = KvEncryptionAES256XTSKey.AES_BLOCK_BYTES;
        if (input.length === 0) {
            return new Uint8Array(0);
        }
        if (input.length % blockBytes !== 0) {
            throw new KvError_Enc_Key(`XTS input length ${input.length} is not a multiple of ${blockBytes} (no ciphertext-stealing in this implementation).`);
        }

        // Encode the sector number as 16 bytes little-endian (XTS standard).
        const sectorBytes = new Uint8Array(blockBytes);
        new DataView(sectorBytes.buffer).setBigUint64(0, BigInt(sectorNumber), true);

        // Initial tweak: AES-ECB(tweakKey, sectorBytes).
        const tweakCipher = createCipheriv('aes-256-ecb', tweakKey, null);
        tweakCipher.setAutoPadding(false);
        const initialTweak = concatBytes([tweakCipher.update(sectorBytes), tweakCipher.final()]);
        // Sanity: initialTweak should be exactly one AES block.

        const numBlocks = input.length / blockBytes;
        const xoredIn = new Uint8Array(input.length);

        // Pre-XOR every plaintext block with its tweak; collect the
        // tweaks so we can post-XOR after the AES pass.
        const tweaks: Uint8Array[] = new Array<Uint8Array>(numBlocks);
        // Annotate as the wide Uint8Array (== Uint8Array<ArrayBufferLike>);
        // gfMultByAlpha returns the same widened form so reassignment below
        // type-checks under TS strict.
        let currentTweak: Uint8Array = new Uint8Array(blockBytes);
        currentTweak.set(initialTweak);
        for (let i = 0; i < numBlocks; i++) {
            tweaks[i] = currentTweak;
            const off = i * blockBytes;
            for (let j = 0; j < blockBytes; j++) {
                xoredIn[off + j] = input[off + j] ^ currentTweak[j];
            }
            currentTweak = KvEncryptionAES256XTSKey.gfMultByAlpha(currentTweak);
        }

        // One AES-ECB pass over all the XORed blocks.
        const aesCipher = encryptMode
            ? createCipheriv('aes-256-ecb', dataKey, null)
            : createDecipheriv('aes-256-ecb', dataKey, null);
        aesCipher.setAutoPadding(false);
        const aesOut = concatBytes([aesCipher.update(xoredIn), aesCipher.final()]);

        // Post-XOR with the same tweaks.
        const output = new Uint8Array(input.length);
        for (let i = 0; i < numBlocks; i++) {
            const off = i * blockBytes;
            const tweak = tweaks[i];
            for (let j = 0; j < blockBytes; j++) {
                output[off + j] = aesOut[off + j] ^ tweak[j];
            }
        }
        return output;
    }

    /**
     * Multiply a 16-byte tweak by α in GF(2^128) using the IEEE P1619
     * reduction polynomial x^128 + x^7 + x^2 + x + 1 (low byte 0x87).
     * The tweak is laid out little-endian byte order (XTS convention).
     */
    private static gfMultByAlpha(t: Uint8Array): Uint8Array {
        const out = new Uint8Array(16);
        let carry = 0;
        for (let i = 0; i < 16; i++) {
            const next = (t[i] >> 7) & 1;
            out[i] = ((t[i] << 1) | carry) & 0xff;
            carry = next;
        }
        if (carry) out[0] ^= 0x87;
        return out;
    }
}
