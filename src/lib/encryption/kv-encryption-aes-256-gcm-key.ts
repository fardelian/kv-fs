import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { concatBytes, KvError_Enc_Key } from '../utils';
import { KvEncryption } from './helpers/kv-encryption';

/**
 * AES-256-GCM — authenticated encryption (AEAD). Each block is enciphered
 * with a fresh 12-byte nonce and the block ID is mixed in as additional
 * authenticated data, so the server can't swap or replay blocks without
 * the tag failing on read.
 *
 * On-disk per block:
 * ```
 *   [0..12)            nonce (random per write)
 *   [12..len-16)       ciphertext (same length as plaintext)
 *   [len-16..len)      auth tag
 * ```
 *
 * Total overhead: 28 bytes (12-byte nonce + 16-byte tag). The tag is
 * verified on decrypt; tampering or block-swap attempts produce a
 * `decipher.final()` exception.
 *
 * For zero-knowledge storage this is the recommended cipher: the server
 * sees only opaque (nonce ‖ ciphertext ‖ tag) tuples and cannot mutate
 * any of them undetected.
 */
export class KvEncryptionAES256GCMKey extends KvEncryption {
    public static readonly KEY_LENGTH_BYTES = 32;
    /** Standard 96-bit nonce length for GCM. */
    public static readonly NONCE_LENGTH_BYTES = 12;
    /** Standard 128-bit GCM tag. */
    public static readonly TAG_LENGTH_BYTES = 16;

    public readonly overheadBytes
        = KvEncryptionAES256GCMKey.NONCE_LENGTH_BYTES + KvEncryptionAES256GCMKey.TAG_LENGTH_BYTES;

    private readonly key: Uint8Array;

    constructor(key: Uint8Array) {
        super();
        if (key.length !== KvEncryptionAES256GCMKey.KEY_LENGTH_BYTES) {
            throw new KvError_Enc_Key(`Encryption key must be ${KvEncryptionAES256GCMKey.KEY_LENGTH_BYTES * 8} bits (${KvEncryptionAES256GCMKey.KEY_LENGTH_BYTES} bytes). Received ${key.length} bytes.`);
        }
        this.key = new Uint8Array(key);
    }

    public async encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const nonce = randomBytes(KvEncryptionAES256GCMKey.NONCE_LENGTH_BYTES);
        const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
        cipher.setAAD(this.aadFromBlockId(blockId));
        const ciphertext = concatBytes([cipher.update(data), cipher.final()]);
        const tag = cipher.getAuthTag();
        return concatBytes([nonce, ciphertext, tag]);
    }

    public async decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const overhead = KvEncryptionAES256GCMKey.NONCE_LENGTH_BYTES + KvEncryptionAES256GCMKey.TAG_LENGTH_BYTES;
        if (data.length < overhead) {
            throw new KvError_Enc_Key(`Ciphertext is shorter (${data.length} bytes) than the GCM framing overhead (${overhead} bytes).`);
        }

        const nonce = data.subarray(0, KvEncryptionAES256GCMKey.NONCE_LENGTH_BYTES);
        const ciphertext = data.subarray(
            KvEncryptionAES256GCMKey.NONCE_LENGTH_BYTES,
            data.length - KvEncryptionAES256GCMKey.TAG_LENGTH_BYTES,
        );
        const tag = data.subarray(data.length - KvEncryptionAES256GCMKey.TAG_LENGTH_BYTES);

        const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
        decipher.setAAD(this.aadFromBlockId(blockId));
        decipher.setAuthTag(tag);

        return concatBytes([decipher.update(ciphertext), decipher.final()]);
    }

    /** Encode the block ID as 8 bytes big-endian for use as additional authenticated data. */
    private aadFromBlockId(blockId: number): Uint8Array {
        const aad = new Uint8Array(8);
        new DataView(aad.buffer).setBigUint64(0, BigInt(blockId));
        return aad;
    }

    public static generateRandomKey(): Uint8Array {
        return randomBytes(KvEncryptionAES256GCMKey.KEY_LENGTH_BYTES);
    }
}
