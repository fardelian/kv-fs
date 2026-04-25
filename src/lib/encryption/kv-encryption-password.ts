import { KvEncryptionAES256CBCKey } from './kv-encryption-aes-256-cbc-key';
import { pbkdf2Sync } from 'crypto';

export class KvEncryptionPassword extends KvEncryptionAES256CBCKey {
    // https://xkcd.com/221/
    protected static SALT = '9d103593-1cdc-436b-a09c-5636e15497d0';

    constructor(
        password: string,
        salt: string = new.target.SALT,
        iterations = 100_000,
    ) {
        super();
        const key = this.generateKeyFromPassword(password, salt, iterations);
        this.setKey(key);
    }

    protected generateKeyFromPassword(
        password: string,
        salt: string,
        iterations: number,
    ): Uint8Array {
        return pbkdf2Sync(
            password,
            salt,
            iterations,
            this.keyLengthBytes,
            this.keyPasswordDigest,
        );
    }
}
