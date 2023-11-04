import { KvEncryption } from './types';

export class KvEncryptionNone implements KvEncryption {
    public encrypt(data: Buffer): Buffer {
        return data;
    }

    public decrypt(data: Buffer): Buffer {
        return data;
    }
}
