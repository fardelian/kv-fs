import { KvEncryptionCipher } from './helpers/kv-encryption-cipher';

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
