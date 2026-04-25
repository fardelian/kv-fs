import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KvError_Enc_Key, concatBytes, Init } from '../../utils';
import { KvEncryption } from './kv-encryption';
import { CipherGCMTypes } from 'node:crypto';

/** AES block size in bytes — used as the PKCS#7 padding overhead. */
const AES_BLOCK_BYTES = 16;

export abstract class KvEncryptionCipher extends KvEncryption {
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
        super();

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

    public setKey(key: Uint8Array) {
        if (key.length !== this.keyLengthBytes) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received ${key.length} bytes.`);
        }
        this.key = new Uint8Array(key);
    }

    protected async init() {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.key) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received none.`);
        }
    }

    // CBC + PKCS#7 doesn't need a per-block tweak — the random IV is what
    // makes each ciphertext unique. `_blockId` is part of the unified
    // `KvEncryption` API so tweakable schemes (XTS) and untweakable ones
    // share a single shape.
    @Init
    public async encrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        const iv = randomBytes(this.ivLengthBytes); // Initialization vector
        const cipher = createCipheriv(this.algorithm, this.key, iv);

        const encryptedData = concatBytes([cipher.update(data), cipher.final()]);

        // The IV is needed for decryption, so we include it with the encrypted data
        return concatBytes([iv, encryptedData]);
    }

    @Init
    public async decrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        // The IV was prepended to the encrypted data. Use `subarray` so the
        // slices respect `data.byteOffset` — `data.buffer` would point at the
        // underlying ArrayBuffer's start, which is wrong if `data` is a view
        // into a larger buffer.
        const iv = data.subarray(0, this.ivLengthBytes);
        const encryptedData = data.subarray(this.ivLengthBytes);

        const decipher = createDecipheriv(
            this.algorithm,
            this.key,
            iv,
        );

        return concatBytes([
            decipher.update(encryptedData),
            decipher.final(),
        ]);
    }

    public generateRandomKey(): Uint8Array {
        return randomBytes(this.keyLengthBytes);
    }
}
