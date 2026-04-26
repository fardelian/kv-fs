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
 * Uses Node's native `aes-256-xts` cipher directly.
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

    private readonly key: Uint8Array;

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
        this.key = new Uint8Array(key);
    }

    public async encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        if (data.length === 0) return new Uint8Array(0);
        if (data.length % KvEncryptionAES256XTSKey.AES_BLOCK_BYTES !== 0) {
            throw new KvError_Enc_Key(`XTS input length ${data.length} is not a multiple of ${KvEncryptionAES256XTSKey.AES_BLOCK_BYTES} (no ciphertext-stealing in this implementation).`);
        }
        const tweak = KvEncryptionAES256XTSKey.tweakBytes(blockId);
        const cipher = createCipheriv('aes-256-xts', this.key, tweak);
        cipher.setAutoPadding(false);
        return concatBytes([cipher.update(data), cipher.final()]);
    }

    public async decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        if (data.length === 0) return new Uint8Array(0);
        if (data.length % KvEncryptionAES256XTSKey.AES_BLOCK_BYTES !== 0) {
            throw new KvError_Enc_Key(`XTS input length ${data.length} is not a multiple of ${KvEncryptionAES256XTSKey.AES_BLOCK_BYTES} (no ciphertext-stealing in this implementation).`);
        }
        const tweak = KvEncryptionAES256XTSKey.tweakBytes(blockId);
        const decipher = createDecipheriv('aes-256-xts', this.key, tweak);
        decipher.setAutoPadding(false);
        return concatBytes([decipher.update(data), decipher.final()]);
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

    /**
     * Encode the block / sector number as a 16-byte tweak: little-
     * endian uint32 in the low 4 bytes, the remaining 12 bytes left
     * as zero. Block IDs are uint32 across the codebase, so 4 bytes
     * is enough.
     */
    private static tweakBytes(blockId: number): Uint8Array {
        const tweak = new Uint8Array(KvEncryptionAES256XTSKey.AES_BLOCK_BYTES);
        new DataView(tweak.buffer).setUint32(0, blockId, true);
        return tweak;
    }
}
