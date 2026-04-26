import { describe, it, expect } from 'test-globals';
import {
    KV_PASSWORD_AUTH_KEY_LENGTH_BYTES,
    kvPasswordAuthDeriveAuthKey,
    kvPasswordAuthDeriveEncryptionKey,
    kvPasswordAuthGenerateChallenge,
    kvPasswordAuthRegister,
    kvPasswordAuthRespondToChallenge,
    kvPasswordAuthVerifyChallenge,
} from './kv-password-auth';

const PASSWORD = 'correct horse battery staple';
const ITERATIONS = 1; // tests don't need real iteration counts

describe('KvPasswordAuth', () => {
    describe('register', () => {
        it('returns a verifier the client can hand to the server and an encryption key the client keeps', () => {
            const { verifier, encryptionKey } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);

            expect(verifier.saltHex).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
            expect(verifier.authVerifierHex).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
            expect(verifier.iterations).toBe(ITERATIONS);
            expect(encryptionKey.length).toBe(KV_PASSWORD_AUTH_KEY_LENGTH_BYTES);
        });

        it('uses a fresh salt per registration — same password registers twice with different verifiers', () => {
            const a = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const b = kvPasswordAuthRegister(PASSWORD, ITERATIONS);

            expect(a.verifier.saltHex).not.toBe(b.verifier.saltHex);
            expect(a.verifier.authVerifierHex).not.toBe(b.verifier.authVerifierHex);
            expect(Array.from(a.encryptionKey)).not.toEqual(Array.from(b.encryptionKey));
        });

        it('domain-separates the auth key and the encryption key (they are different)', () => {
            const { verifier, encryptionKey } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const authKey = kvPasswordAuthDeriveAuthKey(PASSWORD, verifier.saltHex, ITERATIONS);

            expect(Array.from(authKey)).not.toEqual(Array.from(encryptionKey));
        });
    });

    describe('login (challenge-response)', () => {
        it('the right password verifies', () => {
            const { verifier } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const challenge = kvPasswordAuthGenerateChallenge();

            const authKey = kvPasswordAuthDeriveAuthKey(PASSWORD, verifier.saltHex, ITERATIONS);
            const response = kvPasswordAuthRespondToChallenge(authKey, challenge);

            expect(kvPasswordAuthVerifyChallenge(verifier, challenge, response)).toBe(true);
        });

        it('the wrong password does not verify', () => {
            const { verifier } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const challenge = kvPasswordAuthGenerateChallenge();

            const wrongKey = kvPasswordAuthDeriveAuthKey('wrong password', verifier.saltHex, ITERATIONS);
            const response = kvPasswordAuthRespondToChallenge(wrongKey, challenge);

            expect(kvPasswordAuthVerifyChallenge(verifier, challenge, response)).toBe(false);
        });

        it('a response replayed against a different challenge does not verify', () => {
            const { verifier } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const challengeA = kvPasswordAuthGenerateChallenge();
            const challengeB = kvPasswordAuthGenerateChallenge();

            const authKey = kvPasswordAuthDeriveAuthKey(PASSWORD, verifier.saltHex, ITERATIONS);
            const responseA = kvPasswordAuthRespondToChallenge(authKey, challengeA);

            expect(kvPasswordAuthVerifyChallenge(verifier, challengeA, responseA)).toBe(true);
            expect(kvPasswordAuthVerifyChallenge(verifier, challengeB, responseA)).toBe(false);
        });

        it('a tampered response of the same length does not verify', () => {
            const { verifier } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const challenge = kvPasswordAuthGenerateChallenge();

            const authKey = kvPasswordAuthDeriveAuthKey(PASSWORD, verifier.saltHex, ITERATIONS);
            const response = kvPasswordAuthRespondToChallenge(authKey, challenge);
            const tampered = new Uint8Array(response);
            tampered[0] ^= 0x01;

            expect(kvPasswordAuthVerifyChallenge(verifier, challenge, tampered)).toBe(false);
        });

        it('a response of the wrong length does not verify', () => {
            const { verifier } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);
            const challenge = kvPasswordAuthGenerateChallenge();

            const truncated = new Uint8Array(16);
            expect(kvPasswordAuthVerifyChallenge(verifier, challenge, truncated)).toBe(false);
        });
    });

    describe('encryption key derivation', () => {
        it('client can re-derive the same encryption key from password + saltHex + iterations', () => {
            const { verifier, encryptionKey } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);

            const reDerived = kvPasswordAuthDeriveEncryptionKey(
                PASSWORD,
                verifier.saltHex,
                ITERATIONS,
            );

            expect(Array.from(reDerived)).toEqual(Array.from(encryptionKey));
        });

        it('different passwords yield different encryption keys', () => {
            const { verifier, encryptionKey } = kvPasswordAuthRegister(PASSWORD, ITERATIONS);

            const otherKey = kvPasswordAuthDeriveEncryptionKey(
                'something else',
                verifier.saltHex,
                ITERATIONS,
            );

            expect(Array.from(otherKey)).not.toEqual(Array.from(encryptionKey));
        });
    });
});
