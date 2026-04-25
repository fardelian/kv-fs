import { describe, it, expect, beforeEach } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvEncryptionAES256XTSKey } from './kv-encryption-aes-256-xts-key';
import { KvError_Enc_Key } from '../utils';

const KEY_BYTES = 64;
// XTS requires plaintexts of at least one AES block (16 bytes).
const MIN_PLAINTEXT_BYTES = 16;

/**
 * Build a deterministic 64-byte test key. AES-XTS requires the data key
 * half and the tweak key half to differ, so we fill the second half with
 * `seed XOR 0xff` rather than the same byte across the whole buffer.
 */
function fixedKey(seed = 0x42): Uint8Array {
    const key = new Uint8Array(KEY_BYTES);
    key.fill(seed, 0, KEY_BYTES / 2);
    key.fill(seed ^ 0xff, KEY_BYTES / 2);
    return key;
}

function pattern(length: number, seed = 0): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
    return out;
}

describe('KvEncryptionAES256XTSKey', () => {
    let xts: KvEncryptionAES256XTSKey;
    let blockId: number;

    beforeEach(() => {
        xts = new KvEncryptionAES256XTSKey(fixedKey());
        blockId = faker.number.int({ min: 0, max: 1000 });
    });

    describe('constructor', () => {
        it('rejects keys that are not 64 bytes long', () => {
            expect(() => new KvEncryptionAES256XTSKey(new Uint8Array(32))).toThrow(KvError_Enc_Key);
            expect(() => new KvEncryptionAES256XTSKey(new Uint8Array(63))).toThrow(KvError_Enc_Key);
            expect(() => new KvEncryptionAES256XTSKey(new Uint8Array(65))).toThrow(KvError_Enc_Key);
            expect(() => new KvEncryptionAES256XTSKey(new Uint8Array(0))).toThrow(KvError_Enc_Key);
        });

        it('accepts a 64-byte key', () => {
            expect(() => new KvEncryptionAES256XTSKey(fixedKey())).not.toThrow();
        });
    });

    describe('overhead', () => {
        it('reports 0 overhead (length-preserving)', () => {
            expect(xts.overheadBytes).toBe(0);
        });

        it('produces ciphertext exactly the same length as plaintext', async () => {
            for (const length of [16, 17, 32, 256, 4096]) {
                const ciphertext = await xts.encrypt(blockId, pattern(length));
                expect(ciphertext.length).toBe(length);
            }
        });
    });

    describe('round-trip', () => {
        it('decrypts what encrypt produced (16-byte plaintext)', async () => {
            const plaintext = pattern(16);

            const ciphertext = await xts.encrypt(blockId, plaintext);
            const decrypted = await xts.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts what encrypt produced (4 KiB plaintext, the natural block size)', async () => {
            const plaintext = pattern(4096, 0x11);

            const ciphertext = await xts.encrypt(blockId, plaintext);
            const decrypted = await xts.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts what encrypt produced (random binary content)', async () => {
            const plaintext = new Uint8Array(faker.number.int({ min: MIN_PLAINTEXT_BYTES, max: 8192 }));
            for (let i = 0; i < plaintext.length; i++) {
                plaintext[i] = faker.number.int({ min: 0, max: 255 });
            }

            const ciphertext = await xts.encrypt(blockId, plaintext);
            const decrypted = await xts.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });
    });

    describe('determinism and tweak behaviour', () => {
        it('is deterministic — same key + blockId + plaintext yields the same ciphertext', async () => {
            const plaintext = pattern(64);

            const c1 = await xts.encrypt(blockId, plaintext);
            const c2 = await xts.encrypt(blockId, plaintext);

            expect(Array.from(c1)).toEqual(Array.from(c2));
        });

        it('produces different ciphertexts for the same plaintext at different blockIds', async () => {
            const plaintext = pattern(64);

            const c0 = await xts.encrypt(0, plaintext);
            const c1 = await xts.encrypt(1, plaintext);
            const c2 = await xts.encrypt(2, plaintext);

            expect(Array.from(c0)).not.toEqual(Array.from(c1));
            expect(Array.from(c1)).not.toEqual(Array.from(c2));
            expect(Array.from(c0)).not.toEqual(Array.from(c2));
        });

        it('decrypting with the wrong blockId yields different plaintext', async () => {
            const plaintext = pattern(64);
            const ciphertext = await xts.encrypt(7, plaintext);

            const wrong = await xts.decrypt(8, ciphertext);

            expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
        });

        it('decrypting with a different key yields different plaintext', async () => {
            const plaintext = pattern(64);
            const ciphertext = await xts.encrypt(blockId, plaintext);

            const otherXts = new KvEncryptionAES256XTSKey(fixedKey(0x99));
            const wrong = await otherXts.decrypt(blockId, ciphertext);

            expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
        });

        it('does not mutate the input buffer', async () => {
            const plaintext = pattern(64);
            const snapshot = Array.from(plaintext);

            await xts.encrypt(blockId, plaintext);

            expect(Array.from(plaintext)).toEqual(snapshot);
        });
    });

    describe('generateRandomKey', () => {
        it('returns a 64-byte buffer', () => {
            const key = KvEncryptionAES256XTSKey.generateRandomKey();
            expect(key).toBeInstanceOf(Uint8Array);
            expect(key.length).toBe(KEY_BYTES);
        });

        it('returns a different key on repeated calls', () => {
            const k1 = KvEncryptionAES256XTSKey.generateRandomKey();
            const k2 = KvEncryptionAES256XTSKey.generateRandomKey();

            expect(Array.from(k1)).not.toEqual(Array.from(k2));
        });
    });
});
