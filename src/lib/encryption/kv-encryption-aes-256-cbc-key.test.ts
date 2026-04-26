import { describe, it, expect, beforeEach } from 'test-globals';
import { faker } from '@faker-js/faker';
import { KvEncryptionAES256CBCKey } from './kv-encryption-aes-256-cbc-key';
import { KvError_Enc_Key } from '../utils';

const KEY_BYTES = 32;
const IV_BYTES = 16;
const AES_BLOCK_BYTES = 16;

function fixedKey(byte = 0x42): Uint8Array {
    const key = new Uint8Array(KEY_BYTES);
    key.fill(byte);
    return key;
}

function pattern(length: number, seed = 0): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
    return out;
}

describe('KvEncryptionAES256CBCKey', () => {
    let cbc: KvEncryptionAES256CBCKey;
    let blockId: number;

    beforeEach(() => {
        cbc = new KvEncryptionAES256CBCKey();
        cbc.setKey(fixedKey());
        blockId = faker.number.int({ min: 0, max: 1000 });
    });

    describe('overhead', () => {
        it('reports 32 bytes (16-byte IV + one full PKCS#7 padding block)', () => {
            expect(cbc.overheadBytes).toBe(IV_BYTES + AES_BLOCK_BYTES);
        });
    });

    describe('setKey', () => {
        it.each([0, 16, 31, 33])('rejects a %i-byte key', (byteCount) => {
            const fresh = new KvEncryptionAES256CBCKey();

            expect(() => {
                fresh.setKey(new Uint8Array(byteCount));
            }).toThrow(KvError_Enc_Key);
        });

        it('accepts a 32-byte key', () => {
            const fresh = new KvEncryptionAES256CBCKey();

            expect(() => {
                fresh.setKey(fixedKey());
            }).not.toThrow();
        });
    });

    describe('encrypt without setKey', () => {
        it('rejects encrypt when no key has been set', async () => {
            const fresh = new KvEncryptionAES256CBCKey();

            await expect(fresh.encrypt(blockId, pattern(16))).rejects.toThrow(KvError_Enc_Key);
        });

        it('rejects decrypt when no key has been set', async () => {
            const fresh = new KvEncryptionAES256CBCKey();

            await expect(fresh.decrypt(blockId, pattern(48))).rejects.toThrow(KvError_Enc_Key);
        });
    });

    describe('round-trip', () => {
        it('decrypts what encrypt produced (empty plaintext)', async () => {
            const plaintext = new Uint8Array(0);

            const ciphertext = await cbc.encrypt(blockId, plaintext);
            const decrypted = await cbc.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts what encrypt produced (block-aligned plaintext)', async () => {
            const plaintext = pattern(AES_BLOCK_BYTES * 4);

            const ciphertext = await cbc.encrypt(blockId, plaintext);
            const decrypted = await cbc.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts what encrypt produced (non-block-aligned plaintext)', async () => {
            const plaintext = pattern(123);

            const ciphertext = await cbc.encrypt(blockId, plaintext);
            const decrypted = await cbc.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts what encrypt produced (random binary content)', async () => {
            const plaintext = new Uint8Array(faker.number.int({ min: 0, max: 4000 }));
            for (let i = 0; i < plaintext.length; i++) {
                plaintext[i] = faker.number.int({ min: 0, max: 255 });
            }

            const ciphertext = await cbc.encrypt(blockId, plaintext);
            const decrypted = await cbc.decrypt(blockId, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });
    });

    describe('ciphertext shape', () => {
        it('starts the ciphertext with a 16-byte IV followed by aligned ciphertext blocks', async () => {
            // Plaintext of N bytes pads up to ceil((N+1)/16)*16 bytes, then
            // gets prefixed with the 16-byte IV. So total = 16 + paddedLen.
            for (const inputLen of [0, 1, 15, 16, 17, 31, 32]) {
                const ciphertext = await cbc.encrypt(blockId, pattern(inputLen));
                const paddedLen = (Math.floor(inputLen / AES_BLOCK_BYTES) + 1) * AES_BLOCK_BYTES;
                expect(ciphertext.length).toBe(IV_BYTES + paddedLen);
            }
        });

        it('produces a different ciphertext for each call (random IV)', async () => {
            const plaintext = pattern(64);

            const c1 = await cbc.encrypt(blockId, plaintext);
            const c2 = await cbc.encrypt(blockId, plaintext);

            expect(Array.from(c1)).not.toEqual(Array.from(c2));
        });

        it('ignores the blockId — the same plaintext on two blockIds round-trips identically', async () => {
            const plaintext = pattern(64);

            const c0 = await cbc.encrypt(0, plaintext);
            const c1 = await cbc.encrypt(99, plaintext);

            // Different IVs make the ciphertexts differ, but cross-decryption
            // works because CBC's blockId is a no-op.
            expect(Array.from(await cbc.decrypt(0, c0))).toEqual(Array.from(plaintext));
            expect(Array.from(await cbc.decrypt(99, c0))).toEqual(Array.from(plaintext));
            expect(Array.from(await cbc.decrypt(0, c1))).toEqual(Array.from(plaintext));
        });
    });

    describe('wrong-key behaviour', () => {
        it('decrypting with a different key fails or produces garbage', async () => {
            const plaintext = pattern(64);
            const ciphertext = await cbc.encrypt(blockId, plaintext);

            const other = new KvEncryptionAES256CBCKey();
            other.setKey(fixedKey(0x99));

            // Either the padding check throws, or we get back bytes that
            // are not the original plaintext. Both outcomes are "the wrong
            // key didn't recover the plaintext", which is what we assert.
            try {
                const wrong = await other.decrypt(blockId, ciphertext);
                expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
            } catch (err) {
                expect(err).toBeDefined();
            }
        });
    });

    describe('generateRandomKey', () => {
        it('returns a 32-byte buffer', () => {
            const key = cbc.generateRandomKey();
            expect(key).toBeInstanceOf(Uint8Array);
            expect(key.length).toBe(KEY_BYTES);
        });

        it('returns a different key on repeated calls', () => {
            const k1 = cbc.generateRandomKey();
            const k2 = cbc.generateRandomKey();

            expect(Array.from(k1)).not.toEqual(Array.from(k2));
        });
    });
});
