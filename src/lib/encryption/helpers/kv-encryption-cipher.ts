import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KvError_Enc_Key } from '../../utils/errors';
import { concatBytes } from '../../utils/bytes';
import { KvEncryption } from './kv-encryption';
import { Init } from '../../utils/init';
import { CipherGCMTypes } from 'node:crypto';

export abstract class KvEncryptionCipher extends KvEncryption {
    protected readonly algorithm: CipherGCMTypes;
    protected readonly keyLengthBytes: number;
    protected readonly ivLengthBytes: number;
    protected readonly keyPasswordDigest;

    protected key?: Uint8Array;

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

    public setKey(key: Uint8Array) {
        if (key.length !== this.keyLengthBytes) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received ${key.length} bytes.`);
        }
        this.key = new Uint8Array(key);
    }

    protected async init() {
        if (!this.key) {
            throw new KvError_Enc_Key(`Encryption key must be ${this.keyLengthBytes * 8} bits (${this.keyLengthBytes} bytes). Received none.`);
        }
    }

    @Init
    public async encrypt(data: Uint8Array): Promise<Uint8Array> {
        const iv = randomBytes(this.ivLengthBytes); // Initialization vector
        const cipher = createCipheriv(this.algorithm, this.key!, iv);

        const encryptedData = concatBytes([cipher.update(data), cipher.final()]);

        // The IV is needed for decryption, so we include it with the encrypted data
        return concatBytes([iv, encryptedData]);
    }

    @Init
    public async decrypt(data: Uint8Array): Promise<Uint8Array> {
        // The IV was prepended to the encrypted data. Use `subarray` so the
        // slices respect `data.byteOffset` — `data.buffer` would point at the
        // underlying ArrayBuffer's start, which is wrong if `data` is a view
        // into a larger buffer.
        const iv = data.subarray(0, this.ivLengthBytes);
        const encryptedData = data.subarray(this.ivLengthBytes);

        const decipher = createDecipheriv(
            this.algorithm,
            this.key!,
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
