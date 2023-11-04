import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { KvError_Enc_Key } from '../types';

export class KvEncryption {
    private static readonly KEY_LENGTH_BYTES = 32;

    private key: Buffer;
    private algorithm: string = 'aes-256-cbc';

    constructor(key: Buffer) {
        if (key.length !== KvEncryption.KEY_LENGTH_BYTES) {
            throw new KvError_Enc_Key(`Encryption key must be ${KvEncryption.KEY_LENGTH_BYTES * 8} bits (${KvEncryption.KEY_LENGTH_BYTES} bytes). Received ${key.length} bytes.`);
        }

        this.key = key;
    }

    public encrypt(data: Buffer): Buffer {
        const iv = randomBytes(16); // Initialization vector
        const cipher = createCipheriv(this.algorithm, this.key, iv);

        const encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);

        // The IV is needed for decryption, so we include it with the encrypted data
        return Buffer.concat([iv, encryptedData]);
    }

    public decrypt(data: Buffer): Buffer {
        // The IV was prepended to the encrypted data
        const iv = data.subarray(0, 16);
        const encryptedData = data.subarray(16);

        const decipher = createDecipheriv(
            this.algorithm,
            this.key,
            iv,
        );

        return Buffer.concat([
            decipher.update(encryptedData),
            decipher.final(),
        ]);
    }

    public static generateRandomKey(): Buffer {
        return randomBytes(KvEncryption.KEY_LENGTH_BYTES);
    }

    public static generateKeyFromPassword(
        password: string,
        salt: string,
        iterations: number,
    ): Buffer {
        return pbkdf2Sync(
            password,
            salt,
            iterations,
            KvEncryption.KEY_LENGTH_BYTES,
            'sha512',
        );
    }
}
