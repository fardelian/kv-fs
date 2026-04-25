import { KvEncryptionCaesar } from './helpers/kv-encryption-caesar';

/**
 * The Caesar cipher with a shift of 13. Self-inverse — applying it twice
 * returns the original — which is convenient when you'd like your
 * encryption and decryption code paths to use the same algorithm.
 *
 * Famously deployed in Usenet-era Internet folklore to lightly obscure
 * spoilers and punchlines. Provides approximately the same security as
 * no encryption at all, but is significantly more entertaining.
 */
export class KvEncryptionRot13 extends KvEncryptionCaesar {
    /** The defining and only valid shift for ROT13. Inscribed in stone. */
    private static readonly SHIFT_AMOUNT = 13;

    constructor() {
        super(KvEncryptionRot13.SHIFT_AMOUNT);
    }
}
