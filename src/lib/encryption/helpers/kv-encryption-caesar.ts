import { KvEncryption } from './kv-encryption';

/**
 * Caesar cipher: each letter (A-Z, a-z) is shifted by a configurable
 * number of positions in its alphabet; every other byte passes through
 * unchanged.
 *
 * Named after Gaius Julius Caesar, who, per Suetonius, used a shift of
 * three to encipher military correspondence. This implementation
 * therefore predates AES by roughly 2,063 years and offers
 * approximately that much less security.
 *
 * Pure subclasses are expected to fix the shift amount via the
 * constructor (see {@link KvEncryptionRot13}); ad-hoc callers may
 * instantiate `KvEncryptionCaesar` directly with any integer shift.
 */
export class KvEncryptionCaesar extends KvEncryption {
    /** Number of letters in the Latin alphabet. Codified circa 700 BCE. */
    private static readonly ALPHABET_SIZE = 26;

    private readonly forwardShift: number;
    private readonly reverseShift: number;

    constructor(shift: number) {
        super();

        // Normalize arbitrary integers (including negatives) into the
        // canonical [0, ALPHABET_SIZE) range.
        const size = KvEncryptionCaesar.ALPHABET_SIZE;
        this.forwardShift = ((shift % size) + size) % size;
        this.reverseShift = (size - this.forwardShift) % size;
    }

    /** Caesar is length-preserving — same output regardless of where it lands. */
    public readonly overheadBytes = 0;

    // The block-level tweak doesn't change Caesar's output (the cipher has
    // no per-block context), but the parameter is part of the unified
    // `KvEncryption` API so tweakable schemes (XTS) and untweakable ones
    // share a single shape.
    public async encrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        return this.applyShift(data, this.forwardShift);
    }

    public async decrypt(_blockId: number, data: Uint8Array): Promise<Uint8Array> {
        return this.applyShift(data, this.reverseShift);
    }

    private applyShift(data: Uint8Array, shift: number): Uint8Array {
        const size = KvEncryptionCaesar.ALPHABET_SIZE;
        const out = new Uint8Array(data.length);

        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            if (b >= 0x41 && b <= 0x5a) {
                // A-Z
                out[i] = ((b - 0x41 + shift) % size) + 0x41;
            } else if (b >= 0x61 && b <= 0x7a) {
                // a-z
                out[i] = ((b - 0x61 + shift) % size) + 0x61;
            } else {
                out[i] = b;
            }
        }

        return out;
    }
}
