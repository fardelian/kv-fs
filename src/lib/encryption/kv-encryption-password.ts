import { pbkdf2Sync } from 'crypto';
import { KvEncryptionKey } from './kv-encryption-key';

export class KvEncryptionPassword extends KvEncryptionKey {
    protected static readonly ITERATIONS = 100000;

    constructor(
        password: string,
        salt: string,
        iterations: number = KvEncryptionPassword.ITERATIONS,
    ) {
        const key = KvEncryptionPassword.generateKeyFromPassword(password, salt, iterations);
        super(key);
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
            super.KEY_LENGTH_BYTES,
            'sha512',
        );
    }
}
