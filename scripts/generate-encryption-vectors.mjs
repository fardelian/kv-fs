// Generate hard-coded test vectors for every cipher in src/lib/encryption
// using *raw* Node crypto primitives — no kv-fs classes involved. Run with
// real Node (not Bun) so the output is anchored to a reference
// implementation independent of the runtime that runs the test suite:
//
//     node scripts/generate-encryption-vectors.mjs
//
// Paste the printed hex constants into the matching `.test.ts` files.
// Re-run if you change the underlying inputs (key bytes, IV, nonce,
// blockId, plaintext) — the test constants must agree byte-for-byte
// with what `createCipheriv` / `pbkdf2Sync` produce here.

import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';

function bytesToHex(b) {
    return Buffer.from(b).toString('hex');
}

function pattern(length, seed = 0) {
    const out = Buffer.alloc(length);
    for (let i = 0; i < length; i++) out[i] = (i + seed) & 0xff;
    return out;
}

function fixedKey32(byte = 0x42) {
    return Buffer.alloc(32, byte);
}

function fixedKey64() {
    // XTS demands the data half and the tweak half differ — the IEEE
    // P1619 spec rejects equal halves. Mirror what fixedKey() in the
    // XTS test file does: 0x42 for the first 32 bytes, 0xbd (0x42 ^
    // 0xff) for the last 32.
    const k = Buffer.alloc(64);
    k.fill(0x42, 0, 32);
    k.fill(0xbd, 32, 64);
    return k;
}

function rot13(input) {
    const out = Buffer.alloc(input.length);
    for (let i = 0; i < input.length; i++) {
        const b = input[i];
        if (b >= 0x41 && b <= 0x5a) {
            out[i] = ((b - 0x41 + 13) % 26) + 0x41;
        } else if (b >= 0x61 && b <= 0x7a) {
            out[i] = ((b - 0x61 + 13) % 26) + 0x61;
        } else {
            out[i] = b;
        }
    }
    return out;
}

function header(name) {
    console.log();
    console.log('==== ' + name + ' ====');
}

// ---- ROT13 ----------------------------------------------------------------
header('KvEncryptionRot13');
{
    const plaintext = Buffer.from('Hello, World! 1234');
    const ciphertext = rot13(plaintext);
    console.log('plaintext (utf8):     ', JSON.stringify(plaintext.toString('utf8')));
    console.log('ciphertext (utf8):    ', JSON.stringify(ciphertext.toString('utf8')));
    console.log('plaintext (hex):      ', bytesToHex(plaintext));
    console.log('ciphertext (hex):     ', bytesToHex(ciphertext));
}

// ---- AES-256-CBC ----------------------------------------------------------
header('KvEncryptionAES256CBCKey');
{
    const key = fixedKey32(0x42);
    const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const plaintext = pattern(32); // 2 blocks worth — gets one full padding block on top
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fullOutput = Buffer.concat([iv, encrypted]);
    console.log('key (hex):            ', bytesToHex(key));
    console.log('iv (hex):             ', bytesToHex(iv));
    console.log('plaintext (hex):      ', bytesToHex(plaintext));
    console.log('encrypted only (hex): ', bytesToHex(encrypted));
    console.log('output iv|ct (hex):   ', bytesToHex(fullOutput));
}

// ---- AES-256-GCM ----------------------------------------------------------
header('KvEncryptionAES256GCMKey');
{
    const key = fixedKey32(0x42);
    const nonce = Buffer.from('001122334455667788990011', 'hex'); // 12 bytes
    const blockId = 7;
    // 4-byte big-endian AAD — matches aadFromBlockId after the
    // setUint32 simplification.
    const aad = Buffer.alloc(4);
    aad.writeUInt32BE(blockId, 0);
    const plaintext = pattern(32);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const fullOutput = Buffer.concat([nonce, encrypted, tag]);
    console.log('key (hex):            ', bytesToHex(key));
    console.log('nonce (hex):          ', bytesToHex(nonce));
    console.log('blockId:              ', blockId);
    console.log('aad (hex, 4 bytes BE):', bytesToHex(aad));
    console.log('plaintext (hex):      ', bytesToHex(plaintext));
    console.log('output nonce|ct|tag : ', bytesToHex(fullOutput));
}

// ---- AES-256-XTS ----------------------------------------------------------
header('KvEncryptionAES256XTSKey');
{
    const key = fixedKey64();
    const blockId = 7;
    // 16-byte tweak: blockId as little-endian uint32 in the low 4 bytes,
    // the remaining 12 bytes left as zero. Matches the in-class encoding
    // after the setUint32 simplification.
    const tweak = Buffer.alloc(16);
    tweak.writeUInt32LE(blockId, 0);
    const plaintext = pattern(32);
    const cipher = createCipheriv('aes-256-xts', key, tweak);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    console.log('key (hex):            ', bytesToHex(key));
    console.log('blockId:              ', blockId);
    console.log('tweak (hex, LE+pad):  ', bytesToHex(tweak));
    console.log('plaintext (hex):      ', bytesToHex(plaintext));
    console.log('ciphertext (hex):     ', bytesToHex(encrypted));
}

// ---- Password (PBKDF2-SHA512 → AES-256-CBC) -------------------------------
header('KvEncryptionPassword');
{
    const password = 'correct horse battery staple';
    const salt = 'test-salt-deadbeef';
    const iterations = 1; // tests use 1 to stay fast
    const keyLen = 32;
    const digest = 'sha512';
    const key = pbkdf2Sync(password, salt, iterations, keyLen, digest);
    const iv = Buffer.from('aabbccddeeff00112233445566778899', 'hex');
    const plaintext = pattern(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const fullOutput = Buffer.concat([iv, encrypted]);
    console.log('password:             ', JSON.stringify(password));
    console.log('salt:                 ', JSON.stringify(salt));
    console.log('iterations:           ', iterations);
    console.log('derived key (hex):    ', bytesToHex(key));
    console.log('iv (hex):             ', bytesToHex(iv));
    console.log('plaintext (hex):      ', bytesToHex(plaintext));
    console.log('output iv|ct (hex):   ', bytesToHex(fullOutput));
}
