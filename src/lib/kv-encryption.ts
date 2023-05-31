import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto';

export class FileSystemEncryption {
    private static readonly KEY_LENGTH_BYTES = 32;

    private key: Buffer;
    private algorithm: string = 'aes-256-cbc';

    constructor(key?: Buffer) {
        if (key) {
            if (key.length !== FileSystemEncryption.KEY_LENGTH_BYTES) {
                throw new Error('Key must be 256 bits (32 bytes)');
            }
            this.key = key;
        } else {
            this.key = randomBytes(FileSystemEncryption.KEY_LENGTH_BYTES); // Generate a new 256-bit key if none was provided
        }
    }

    public encrypt(data: Buffer): Buffer {
        const iv = randomBytes(16); // Initialization vector
        const cipher = createCipheriv(this.algorithm, this.key, iv);

        const encryptedData = Buffer.concat([
            cipher.update(data),
            cipher.final(),
        ]);

        // The IV is needed for decryption, so we include it with the encrypted data
        return Buffer.concat([
            iv,
            encryptedData,
        ]);
    }

    public decrypt(data: Buffer): Buffer {
        // The IV was prepended to the encrypted data
        const iv = data.slice(0, 16);
        const encryptedData = data.slice(16);

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

    public getKey(): Buffer {
        return this.key;
    }

    public static keyFromPassword(
        password: string,
        salt: string,
        iterations: number,
    ): Buffer {
        return pbkdf2Sync(
            password,
            salt,
            iterations,
            FileSystemEncryption.KEY_LENGTH_BYTES,
            'sha512',
        );
    }
}
