export abstract class KvEncryption {
    /**
     * Bytes the cipher adds to any input. Subclasses must override.
     * Length-preserving schemes (ROT13, Caesar, AES-XTS) report 0; schemes
     * that store an IV and/or pad the plaintext (AES-CBC, AES-GCM, ...)
     * report the constant they add.
     */
    abstract get overheadBytes(): number;

    /**
     * Encrypt `data` for storage at `blockId`. Tweakable schemes (e.g.
     * AES-XTS) use `blockId` as the tweak so each block enciphers
     * independently of the others. Schemes that don't depend on location
     * (ROT13, AES-CBC with a stored random IV) ignore `blockId`.
     */
    abstract encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;

    abstract decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;
}
