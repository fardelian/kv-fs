/**
 * Contract every cipher in `kv-fs` implements. Defined as an interface
 * (not an abstract class) because the type has no shared runtime
 * behaviour — every member is overridden by every implementer — and an
 * interface emits no JS, keeping the type purely structural.
 */
export interface KvEncryption {
    /**
     * Bytes the cipher adds to any input. Length-preserving schemes
     * (ROT13, Caesar, AES-XTS) report 0; schemes that store an IV and/or
     * pad the plaintext (AES-CBC, AES-GCM, ...) report the constant they
     * add.
     */
    readonly overheadBytes: number;

    /**
     * Encrypt `data` for storage at `blockId`. Tweakable schemes (e.g.
     * AES-XTS) use `blockId` as the tweak so each block enciphers
     * independently of the others. Schemes that don't depend on location
     * (ROT13, AES-CBC with a stored random IV) ignore `blockId`.
     */
    encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;

    decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;
}
