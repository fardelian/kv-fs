import { describe, it, expect, beforeEach } from 'bun:test';
import { faker } from '@faker-js/faker';
import { KvEncryptionAES256GCMKey } from './kv-encryption-aes-256-gcm-key';
import { KvError_Enc_Key } from '../utils';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD = NONCE_BYTES + TAG_BYTES;

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

describe('KvEncryptionAES256GCMKey', () => {
    let gcm: KvEncryptionAES256GCMKey;
    let blockId: number;

    beforeEach(() => {
        gcm = new KvEncryptionAES256GCMKey(fixedKey());
        blockId = faker.number.int({ min: 0, max: 1000 });
    });

    describe('constructor', () => {
        it.each([0, 16, 31, 33, 48, 64])('rejects a %i-byte key', (length) => {
            expect(() => new KvEncryptionAES256GCMKey(new Uint8Array(length))).toThrow(KvError_Enc_Key);
        });

        it('accepts a 32-byte key', () => {
            expect(() => new KvEncryptionAES256GCMKey(fixedKey())).not.toThrow();
        });
    });

    describe('overhead', () => {
        it('reports 28 bytes (12-byte nonce + 16-byte tag)', () => {
            expect(gcm.overheadBytes).toBe(OVERHEAD);
        });

        it('produces ciphertext exactly overhead bytes longer than plaintext', async () => {
            for (const length of [0, 1, 16, 256, 4096]) {
                const ciphertext = await gcm.encrypt(blockId, pattern(length));
                expect(ciphertext.length).toBe(length + OVERHEAD);
            }
        });
    });

    describe('round-trip', () => {
        it('decrypts what encrypt produced (single byte)', async () => {
            const plaintext = new Uint8Array([0xab]);
            const ciphertext = await gcm.encrypt(blockId, plaintext);
            const decrypted = await gcm.decrypt(blockId, ciphertext);
            expect(Array.from(decrypted)).toEqual([0xab]);
        });

        it('decrypts what encrypt produced (4 KiB plaintext)', async () => {
            const plaintext = pattern(4096, 0x11);
            const ciphertext = await gcm.encrypt(blockId, plaintext);
            const decrypted = await gcm.decrypt(blockId, ciphertext);
            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('decrypts an empty plaintext (overhead only)', async () => {
            const plaintext = new Uint8Array(0);
            const ciphertext = await gcm.encrypt(blockId, plaintext);
            expect(ciphertext.length).toBe(OVERHEAD);
            const decrypted = await gcm.decrypt(blockId, ciphertext);
            expect(decrypted.length).toBe(0);
        });
    });

    describe('AEAD properties', () => {
        it('uses a fresh nonce per call so the same plaintext encrypts differently', async () => {
            const plaintext = pattern(64);
            const c1 = await gcm.encrypt(blockId, plaintext);
            const c2 = await gcm.encrypt(blockId, plaintext);
            expect(Array.from(c1)).not.toEqual(Array.from(c2));
        });

        it('rejects ciphertext with a flipped byte (auth tag fails)', async () => {
            const plaintext = pattern(64);
            const ciphertext = await gcm.encrypt(blockId, plaintext);
            // Flip a bit in the middle (in the ciphertext region, between nonce and tag).
            const tampered = new Uint8Array(ciphertext);
            tampered[NONCE_BYTES + 5] ^= 0x01;

            await expect(gcm.decrypt(blockId, tampered)).rejects.toThrow();
        });

        it('rejects ciphertext with a flipped tag byte', async () => {
            const plaintext = pattern(64);
            const ciphertext = await gcm.encrypt(blockId, plaintext);
            const tampered = new Uint8Array(ciphertext);
            tampered[tampered.length - 1] ^= 0x01;

            await expect(gcm.decrypt(blockId, tampered)).rejects.toThrow();
        });

        it('rejects decryption with the wrong blockId (AAD binds the ciphertext to its slot)', async () => {
            const plaintext = pattern(64);
            const ciphertext = await gcm.encrypt(7, plaintext);

            await expect(gcm.decrypt(8, ciphertext)).rejects.toThrow();
        });

        it('rejects decryption with the wrong key', async () => {
            const plaintext = pattern(64);
            const ciphertext = await gcm.encrypt(blockId, plaintext);

            const otherGcm = new KvEncryptionAES256GCMKey(fixedKey(0x99));
            await expect(otherGcm.decrypt(blockId, ciphertext)).rejects.toThrow();
        });

        it('rejects ciphertext shorter than the framing overhead', async () => {
            await expect(gcm.decrypt(blockId, new Uint8Array(OVERHEAD - 1))).rejects.toBeInstanceOf(KvError_Enc_Key);
        });
    });

    describe('generateRandomKey', () => {
        it('returns a 32-byte buffer', () => {
            const key = KvEncryptionAES256GCMKey.generateRandomKey();
            expect(key.length).toBe(KEY_BYTES);
        });

        it('returns different bytes on repeated calls', () => {
            const a = KvEncryptionAES256GCMKey.generateRandomKey();
            const b = KvEncryptionAES256GCMKey.generateRandomKey();
            expect(Array.from(a)).not.toEqual(Array.from(b));
        });
    });

    // Hard-coded vectors generated by `scripts/generate-encryption-vectors.mjs`
    // (run with raw Node, not Bun) using `createCipheriv('aes-256-gcm', ...)`
    // with the same key, nonce, and AAD encoding as the class produces. The
    // encrypt test pins the nonce via the constructor's randomBytesProvider
    // override; the decrypt test is naturally deterministic.
    describe('hard-coded vector', () => {
        const KEY_HEX = '4242424242424242424242424242424242424242424242424242424242424242';
        const NONCE_HEX = '001122334455667788990011';
        const PLAINTEXT_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        const FULL_OUTPUT_HEX
            = '001122334455667788990011'
                + '369ed1fa90cf1fe457875a4f00e70007227745ede3e7925c82315202f537bc89'
                + 'a059cfc6c90a2aee24efa184f2fe49ce';
        const FIXED_BLOCK_ID = 7;

        function fromHex(hex: string): Uint8Array {
            return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
        }
        function toHex(bytes: Uint8Array): string {
            return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        }

        it('encrypts a known plaintext to the expected ciphertext bytes', async () => {
            const cipher = new KvEncryptionAES256GCMKey(fromHex(KEY_HEX), () => fromHex(NONCE_HEX));

            const out = await cipher.encrypt(FIXED_BLOCK_ID, fromHex(PLAINTEXT_HEX));
            expect(toHex(out)).toBe(FULL_OUTPUT_HEX);
        });

        it('decrypts a known ciphertext back to the expected plaintext bytes', async () => {
            const cipher = new KvEncryptionAES256GCMKey(fromHex(KEY_HEX));

            const out = await cipher.decrypt(FIXED_BLOCK_ID, fromHex(FULL_OUTPUT_HEX));
            expect(toHex(out)).toBe(PLAINTEXT_HEX);
        });
    });
});
