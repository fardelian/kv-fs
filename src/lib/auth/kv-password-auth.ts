import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * What the server stores for a registered user. It does **not** include
 * the password (that's the zero-knowledge property) and it does not
 * include the encryption key (the client keeps that locally).
 */
export interface KvAuthVerifier {
    /** 16-byte random salt, hex-encoded. Echoed back to the client at login. */
    saltHex: string;
    /** PBKDF2 output keyed on (password, salt + 'auth'); compared at login. Hex. */
    authVerifierHex: string;
    /** PBKDF2 iterations used for both auth and encryption derivations. */
    iterations: number;
}

/** Length of the derived auth and encryption keys (256 bits each). */
export const KV_PASSWORD_AUTH_KEY_LENGTH_BYTES = 32;
/** Length of the per-user random salt. */
export const KV_PASSWORD_AUTH_SALT_LENGTH_BYTES = 16;
/** Length of the random challenge nonce sent on login. */
export const KV_PASSWORD_AUTH_CHALLENGE_LENGTH_BYTES = 32;
/** Default PBKDF2 iteration count; raise if you can spare CPU at login time. */
export const KV_PASSWORD_AUTH_DEFAULT_ITERATIONS = 100_000;

/**
 * Password-authenticated key derivation + challenge-response auth.
 *
 * **Two distinct keys** are derived from a single user password:
 * - **Auth verifier** (`info='auth'`): sent to the server during
 *   registration; used to verify login challenges. Server sees this.
 * - **Encryption key** (`info='enc'`): kept on the client; used by
 *   `KvEncryptedBlockDevice` to encrypt data blocks. Server **never**
 *   sees this.
 *
 * This means even if the server (or anyone with access to the server's
 * datastore) sees `KvAuthVerifier`, they cannot decrypt the user's
 * blocks. The data is zero-knowledge with respect to the server.
 *
 * **Login flow** (challenge-response, password never crosses the wire):
 * 1. Client → server:  `getSalt(username)`
 * 2. Server → client:  `{ saltHex, iterations }` (and a random challenge)
 * 3. Client computes:  `verifier = deriveAuthKey(password, saltHex, iterations)`
 * 4. Client → server:  `respondToChallenge(verifier, challenge)`
 * 5. Server verifies   `verifyChallenge(storedVerifier, challenge, response)`
 * 6. On success, server issues a session token.
 *
 * **Caveats**: this is *not* full OPAQUE. The salt is sent to anyone
 * who asks the server for a username's salt, which leaves the system
 * vulnerable to offline dictionary attacks if the server itself is
 * compromised. OPAQUE avoids this by encoding the salt into a blinded
 * Diffie-Hellman exchange. For a POC where the threat model is
 * "honest-but-curious server" this scheme is adequate.
 */

/**
 * Client-side: register a new password. Returns the verifier the
 * client should send to the server **plus** the encryption key the
 * client should keep locally (or stash in OS keychain / equivalent).
 */
export function kvPasswordAuthRegister(
    password: string,
    iterations: number = KV_PASSWORD_AUTH_DEFAULT_ITERATIONS,
): { verifier: KvAuthVerifier; encryptionKey: Uint8Array } {
    const salt = randomBytes(KV_PASSWORD_AUTH_SALT_LENGTH_BYTES);
    const saltHex = salt.toString('hex');

    const authBytes = derive(password, saltHex, iterations, 'auth');
    const encBytes = derive(password, saltHex, iterations, 'enc');

    return {
        verifier: {
            saltHex,
            authVerifierHex: Buffer.from(authBytes).toString('hex'),
            iterations,
        },
        encryptionKey: encBytes,
    };
}

/**
 * Derive the same 32-byte key the server will compare at login. The
 * client recomputes this from the password (never sends it).
 */
export function kvPasswordAuthDeriveAuthKey(
    password: string,
    saltHex: string,
    iterations: number,
): Uint8Array {
    return derive(password, saltHex, iterations, 'auth');
}

/**
 * Derive the encryption key the client uses with
 * `KvEncryptedBlockDevice`. Same password + salt + iterations gives
 * the same key — the client must keep all three.
 */
export function kvPasswordAuthDeriveEncryptionKey(
    password: string,
    saltHex: string,
    iterations: number,
): Uint8Array {
    return derive(password, saltHex, iterations, 'enc');
}

/** Server-side: pick a fresh challenge nonce for login. */
export function kvPasswordAuthGenerateChallenge(): Uint8Array {
    return new Uint8Array(randomBytes(KV_PASSWORD_AUTH_CHALLENGE_LENGTH_BYTES));
}

/**
 * Client-side: HMAC-SHA256 the challenge using the auth key as the
 * HMAC secret. The server runs the same computation with the stored
 * verifier and compares with `timingSafeEqual`.
 */
export function kvPasswordAuthRespondToChallenge(
    authKey: Uint8Array,
    challenge: Uint8Array,
): Uint8Array {
    const hmac = createHmac('sha256', Buffer.from(authKey));
    hmac.update(challenge);
    return new Uint8Array(hmac.digest());
}

/**
 * Server-side: verify the client's response against the stored
 * verifier. Constant-time compare to avoid timing oracles.
 */
export function kvPasswordAuthVerifyChallenge(
    verifier: KvAuthVerifier,
    challenge: Uint8Array,
    response: Uint8Array,
): boolean {
    const expected = kvPasswordAuthRespondToChallenge(
        new Uint8Array(Buffer.from(verifier.authVerifierHex, 'hex')),
        challenge,
    );
    if (expected.length !== response.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(response));
}

/**
 * PBKDF2-SHA256 with a domain-separated salt (`saltBytes ‖ info`) so
 * the auth key and the encryption key derived from the same password
 * are independent.
 */
function derive(
    password: string,
    saltHex: string,
    iterations: number,
    info: 'auth' | 'enc',
): Uint8Array {
    const salt = Buffer.from(saltHex, 'hex');
    const domainSeparated = Buffer.concat([salt, Buffer.from(info, 'utf-8')]);
    const out = pbkdf2Sync(
        password,
        domainSeparated,
        iterations,
        KV_PASSWORD_AUTH_KEY_LENGTH_BYTES,
        'sha256',
    );
    return new Uint8Array(out);
}
