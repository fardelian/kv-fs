import { KvEncryption } from './types';

export class KvEncryptionNone implements KvEncryption {
    public encrypt(data: Uint8Array): Uint8Array {
        return data;
    }

    public decrypt(data: Uint8Array): Uint8Array {
        return data;
    }
}
