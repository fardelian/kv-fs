import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
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
 * The trade-off is that XTS is unauthenticated — an attacker who can
 * flip ciphertext bits will produce predictable plaintext changes. For
 * authenticated storage, layer a MAC on top or use AES-GCM-SIV (not
 * implemented here).
 *
 * The 512-bit key is internally split into two 256-bit AES keys (the
 * data key and the tweak key); pass them concatenated as one 64-byte
 * Uint8Array.
 */
export class KvEncryptionAES256XTSKey extends KvEncryption {
    /** XTS combines two AES-256 keys; together that's 512 bits. */
    public static readonly KEY_LENGTH_BYTES = 64;

    /** AES block size — also the tweak length XTS expects. */
    private static readonly TWEAK_BYTES = 16;

    /** XTS is length-preserving by construction. */
    public readonly overheadBytes = 0;

    private readonly key: Uint8Array;

    constructor(key: Uint8Array) {
        super();
        if (key.length !== KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES) {
            throw new KvError_Enc_Key(`Encryption key must be ${KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES * 8} bits (${KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES} bytes). Received ${key.length} bytes.`);
        }
        this.key = new Uint8Array(key);
    }

    public async encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const cipher = createCipheriv('aes-256-xts', this.key, this.tweak(blockId));
        return concatBytes([cipher.update(data), cipher.final()]);
    }

    public async decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const decipher = createDecipheriv('aes-256-xts', this.key, this.tweak(blockId));
        return concatBytes([decipher.update(data), decipher.final()]);
    }

    /** Encode the block ID as a 16-byte big-endian tweak. */
    private tweak(blockId: number): Uint8Array {
        const tweak = new Uint8Array(KvEncryptionAES256XTSKey.TWEAK_BYTES);
        new DataView(tweak.buffer).setUint32(0, blockId);
        return tweak;
    }

    public static generateRandomKey(): Uint8Array {
        return randomBytes(KvEncryptionAES256XTSKey.KEY_LENGTH_BYTES);
    }
}
