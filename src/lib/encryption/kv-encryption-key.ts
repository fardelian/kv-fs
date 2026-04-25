import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { KvError_Enc_Key } from '../utils/errors';
import { concatBytes } from '../utils/bytes';
import { KvEncryption } from './types';

export class KvEncryptionKey implements KvEncryption {
    protected static readonly KEY_LENGTH_BYTES = 32;

    private key: Uint8Array;
    private algorithm: string = 'aes-256-cbc';

    constructor(key: Uint8Array) {
        if (key.length !== KvEncryptionKey.KEY_LENGTH_BYTES) {
            throw new KvError_Enc_Key(`Encryption key must be ${KvEncryptionKey.KEY_LENGTH_BYTES * 8} bits (${KvEncryptionKey.KEY_LENGTH_BYTES} bytes). Received ${key.length} bytes.`);
        }

        this.key = key;
    }

    public encrypt(data: Uint8Array): Uint8Array {
        const iv = randomBytes(16); // Initialization vector
        const cipher = createCipheriv(this.algorithm, this.key, iv);

        const encryptedData = concatBytes([cipher.update(data), cipher.final()]);

        // The IV is needed for decryption, so we include it with the encrypted data
        return concatBytes([iv, encryptedData]);
    }

    public decrypt(data: Uint8Array): Uint8Array {
        // The IV was prepended to the encrypted data
        const iv = data.subarray(0, 16);
        const encryptedData = data.subarray(16);

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

    public static generateRandomKey(): Uint8Array {
        return randomBytes(KvEncryptionKey.KEY_LENGTH_BYTES);
    }
}
