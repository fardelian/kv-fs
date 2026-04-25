export abstract class KvEncryption {
    abstract encrypt(data: Uint8Array): Promise<Uint8Array>;

    abstract decrypt(data: Uint8Array): Promise<Uint8Array>;
}
