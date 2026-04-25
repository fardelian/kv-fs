export interface KvEncryption {
    encrypt(data: Uint8Array): Uint8Array;

    decrypt(data: Uint8Array): Uint8Array;
}
