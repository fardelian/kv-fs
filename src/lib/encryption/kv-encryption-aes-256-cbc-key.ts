import { KvEncryptionCipher } from './helpers/kv-encryption-cipher';

/**
 * AES-256 in CBC mode with PKCS#7 padding. Each call generates a fresh
 * 16-byte IV and prepends it to the ciphertext (overhead = 32 bytes).
 * Unauthenticated — for tamper-evident storage prefer
 * `KvEncryptionAES256GCMKey`.
 */
export class KvEncryptionAES256CBCKey extends KvEncryptionCipher {
    constructor() {
        super(
            'aes-256-cbc',
            32,
            16,
            'sha512',
        );
    }
}
