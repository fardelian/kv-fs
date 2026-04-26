import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KvError_Enc_Key, concatBytes, Init } from '../../utils';
import { KvEncryption } from './kv-encryption';
import { CipherGCMTypes } from 'node:crypto';

/** AES block size in bytes — used as the PKCS#7 padding overhead. */
const AES_BLOCK_BYTES = 16;

/**
 * Shared base for symmetric AES schemes that store an IV alongside the
 * ciphertext (CBC, GCM, ...). Subclasses pick the algorithm, key length,
 * and IV length; this class handles encrypt/decrypt and key validation.
 *
 * The key is supplied via `setKey` (or in a subclass constructor) rather
 * than the constructor here, so password-derived classes can run the
 * KDF before installing the key.
 */
export abstract class KvEncryptionCipher implements KvEncryption {
    protected readonly algorithm: CipherGCMTypes;
    protected readonly keyLengthBytes: number;
    protected readonly ivLengthBytes: number;
    protected readonly keyPasswordDigest;

    protected key!: Uint8Array;

    protected constructor(
        algorithm: string,
        keyLengthBytes: number,
        ivLengthBytes: number,
        keyPasswordDigest: string,
    ) {
        // TODO: Switch from CBC to GCM
        this.algorithm = algorithm as CipherGCMTypes;
        this.keyLengthBytes = keyLengthBytes;
        this.ivLengthBytes = ivLengthBytes;
        this.keyPasswordDigest = keyPasswordDigest;
    }

    /**
     * IV (always stored) + one full PKCS#7 padding block (added even when the
     * plaintext is already aligned). Constant per scheme.
     */
    public get overheadBytes(): number {
        return this.ivLengthBytes + AES_BLOCK_BYTES;
    }

    /** Install the symmetric key. Length must match `keyLengthBytes`. */
    public setKey(key: Uint8Array) {
        if (key.length !== this.keyLengthBytes) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received ${key.length} bytes.`);
        }
        this.key = new Uint8Array(key);
    }

    async init() {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.key) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received none.`);
        }
    }

    /**
     * Encrypt `data` with a fresh random IV and prepend the IV to the
     * ciphertext. `blockId` is unused — the IV is what makes each
     * ciphertext unique; the parameter exists to match the
     * `KvEncryption` contract (tweakable schemes like XTS need it).
     */
    @Init
    public async encrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const iv = randomBytes(this.ivLengthBytes);
        const cipher = createCipheriv(this.algorithm, this.key, iv);
        const encryptedData = concatBytes([cipher.update(data), cipher.final()]);
        return concatBytes([iv, encryptedData]);
    }

    /** Decrypt the IV-prepended ciphertext produced by `encrypt`. */
    @Init
    public async decrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        // `subarray` (not `data.buffer`) respects byteOffset when `data`
        // is a view into a larger ArrayBuffer.
        const iv = data.subarray(0, this.ivLengthBytes);
        const encryptedData = data.subarray(this.ivLengthBytes);

        const decipher = createDecipheriv(this.algorithm, this.key, iv);
        return concatBytes([decipher.update(encryptedData), decipher.final()]);
    }

    /** Generate a fresh random key of the configured length. */
    public generateRandomKey(): Uint8Array {
        return randomBytes(this.keyLengthBytes);
    }
}
