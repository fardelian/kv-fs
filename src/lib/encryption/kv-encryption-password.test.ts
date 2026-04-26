import { describe, it, expect } from 'bun:test';
import { faker } from '@faker-js/faker';
import { KvEncryptionPassword } from './kv-encryption-password';

const PASSWORD = 'correct horse battery staple';
const SALT = 'test-salt-deadbeef';
const ITERATIONS = 1; // Tests don't need real iteration counts; keep them fast.

function pattern(length: number, seed = 0): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
    return out;
}

describe('KvEncryptionPassword', () => {
    describe('constructor', () => {
        it('builds a usable cipher from password + salt + iterations', async () => {
            const enc = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);

            const plaintext = pattern(64);
            const ciphertext = await enc.encrypt(0, plaintext);
            const decrypted = await enc.decrypt(0, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('does not require the iterations argument (defaults to 100_000)', () => {
            // Use a small password/salt; this just exercises the default
            // iteration count code path. We don't time it — the test
            // tolerates the ~tens of ms PBKDF2 takes.
            expect(() => new KvEncryptionPassword(PASSWORD, SALT)).not.toThrow();
        });

        it('rejects calls without a salt at the type level', () => {
            // Salt is now a required parameter — the second argument must be
            // supplied. The type system enforces this; this test documents
            // the runtime expectation by calling with no salt and seeing the
            // result still derive a key from `undefined` (which we don't
            // want — but TypeScript stops you before you get here).
            // The point: no `static SALT` default exists on the class
            // anymore, so users cannot accidentally rely on it.
            expect((KvEncryptionPassword as unknown as { SALT?: string }).SALT).toBeUndefined();
        });
    });

    describe('determinism', () => {
        it('same password + salt + iterations derives the same key (cross-instance round-trip)', async () => {
            const enc1 = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);
            const enc2 = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);

            const plaintext = pattern(64);
            const ciphertext = await enc1.encrypt(0, plaintext);
            const decrypted = await enc2.decrypt(0, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });

        it('different passwords produce different keys (decryption fails or yields garbage)', async () => {
            const enc1 = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);
            const enc2 = new KvEncryptionPassword('a different password', SALT, ITERATIONS);

            const plaintext = pattern(64);
            const ciphertext = await enc1.encrypt(0, plaintext);

            try {
                const wrong = await enc2.decrypt(0, ciphertext);
                expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
            } catch (err) {
                expect(err).toBeDefined();
            }
        });

        it('different salts produce different keys (decryption fails or yields garbage)', async () => {
            const enc1 = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);
            const enc2 = new KvEncryptionPassword(PASSWORD, 'a different salt', ITERATIONS);

            const plaintext = pattern(64);
            const ciphertext = await enc1.encrypt(0, plaintext);

            try {
                const wrong = await enc2.decrypt(0, ciphertext);
                expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
            } catch (err) {
                expect(err).toBeDefined();
            }
        });

        it('different iteration counts produce different keys', async () => {
            const enc1 = new KvEncryptionPassword(PASSWORD, SALT, 1);
            const enc2 = new KvEncryptionPassword(PASSWORD, SALT, 2);

            const plaintext = pattern(64);
            const ciphertext = await enc1.encrypt(0, plaintext);

            try {
                const wrong = await enc2.decrypt(0, ciphertext);
                expect(Array.from(wrong)).not.toEqual(Array.from(plaintext));
            } catch (err) {
                expect(err).toBeDefined();
            }
        });
    });

    describe('round-trip', () => {
        it('decrypts what encrypt produced for a random binary payload', async () => {
            const enc = new KvEncryptionPassword(PASSWORD, SALT, ITERATIONS);

            const plaintext = new Uint8Array(faker.number.int({ min: 0, max: 4000 }));
            for (let i = 0; i < plaintext.length; i++) {
                plaintext[i] = faker.number.int({ min: 0, max: 255 });
            }

            const ciphertext = await enc.encrypt(0, plaintext);
            const decrypted = await enc.decrypt(0, ciphertext);

            expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });
    });
});
