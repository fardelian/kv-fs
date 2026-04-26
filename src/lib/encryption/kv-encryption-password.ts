import { KvEncryptionAES256CBCKey } from './kv-encryption-aes-256-cbc-key';
import { pbkdf2Sync } from 'crypto';

/**
 * `KvEncryptionAES256CBCKey` keyed by a password instead of a raw key.
 * Derives the AES-256 key from `(password, salt, iterations)` via
 * PBKDF2-SHA512.
 */
export class KvEncryptionPassword extends KvEncryptionAES256CBCKey {
    /**
     * @param password    The user-supplied password to derive the AES key from.
     * @param salt        Required. Must be unique per deployment (and ideally
     *                    per password) — sharing a salt across deployments
     *                    means rainbow tables built once for that salt break
     *                    every user with the same password, regardless of
     *                    iteration count. Store this alongside the ciphertext
     *                    or in the deployment's config; the same salt must
     *                    be supplied to decrypt.
     * @param iterations  PBKDF2 iteration count. Higher is slower for both
     *                    legitimate users and attackers; 100_000+ recommended.
     */
    constructor(
        password: string,
        salt: string,
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
