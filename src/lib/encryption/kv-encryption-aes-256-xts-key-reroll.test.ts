import { describe, it, expect, beforeAll, beforeEach, jest } from '@jest/globals';
import { timingSafeEqual as realTimingSafeEqual } from 'crypto';

// Mock `crypto.randomBytes` so we can force the `generateRandomKey` reroll
// loop — in practice both 256-bit halves coinciding has 1-in-2^256 odds, so
// it's only reachable under a deterministic mock. `timingSafeEqual` is left
// as the real implementation so the half-comparison logic still runs for
// real; the other crypto exports aren't reached in this test.
const mockRandomBytes = jest.fn<(n: number) => Buffer>();

jest.unstable_mockModule('crypto', () => ({
    randomBytes: mockRandomBytes,
    timingSafeEqual: realTimingSafeEqual,
    createCipheriv: jest.fn(),
    createDecipheriv: jest.fn(),
}));

let KvEncryptionAES256XTSKey: typeof import('./kv-encryption-aes-256-xts-key').KvEncryptionAES256XTSKey;

beforeAll(async () => {
    ({ KvEncryptionAES256XTSKey } = await import('./kv-encryption-aes-256-xts-key'));
});

beforeEach(() => {
    mockRandomBytes.mockReset();
});

describe('KvEncryptionAES256XTSKey.generateRandomKey — reroll path', () => {
    it('rerolls when the random buffer\'s two halves coincide, then returns the next valid one', () => {
        const equalHalves = Buffer.alloc(64, 0x42);
        const validKey = Buffer.from(Array.from({ length: 64 }, (_, i) => i & 0xff));
        mockRandomBytes
            .mockReturnValueOnce(equalHalves)
            .mockReturnValueOnce(validKey);

        const result = KvEncryptionAES256XTSKey.generateRandomKey();

        expect(mockRandomBytes).toHaveBeenCalledTimes(2);
        expect(Array.from(result)).toEqual(Array.from(validKey));
    });
});
