export interface KvEncryption {
    encrypt(data: Buffer): Buffer;

    decrypt(data: Buffer): Buffer;
}
