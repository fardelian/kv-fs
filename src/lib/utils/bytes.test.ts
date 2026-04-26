import { describe, it, expect } from 'test-globals';
import { utf8Decode, utf8Encode, concatBytes, dataView } from './bytes';

describe('utf8Encode / utf8Decode', () => {
    it('round-trips ASCII', () => {
        const encoded = utf8Encode('hello world');
        expect(utf8Decode(encoded)).toBe('hello world');
    });

    it('round-trips UTF-8 multi-byte characters', () => {
        const encoded = utf8Encode('日本語 — café 🎉');
        expect(utf8Decode(encoded)).toBe('日本語 — café 🎉');
    });

    it('decodes a slice when start and end are provided', () => {
        const encoded = utf8Encode('hello world');
        // ASCII so byte offsets line up with character offsets.
        expect(utf8Decode(encoded, 6, 11)).toBe('world');
    });

    it('decodes the full buffer when no start/end is provided', () => {
        const encoded = utf8Encode('whole buffer');
        // No start/end argument — exercises the `start === undefined && end === undefined` branch.
        expect(utf8Decode(encoded)).toBe('whole buffer');
    });
});

describe('concatBytes', () => {
    it('concatenates multiple Uint8Arrays into a single buffer', () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([4, 5]);
        const c = new Uint8Array([6]);

        const merged = concatBytes([a, b, c]);

        expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('returns an empty Uint8Array when given no parts', () => {
        const merged = concatBytes([]);

        expect(merged).toBeInstanceOf(Uint8Array);
        expect(merged.length).toBe(0);
    });
});

describe('dataView', () => {
    it('produces a DataView covering the entire Uint8Array', () => {
        const buf = new Uint8Array(8);
        const view = dataView(buf);

        view.setUint32(0, 0x01020304);
        view.setUint32(4, 0x05060708);

        expect(view.getUint32(0)).toBe(0x01020304);
        expect(view.getUint32(4)).toBe(0x05060708);
    });

    it('respects byteOffset/byteLength when wrapping a subarray', () => {
        const parent = new Uint8Array(16);
        for (let i = 0; i < parent.length; i++) parent[i] = i;
        const child = parent.subarray(4, 12); // 8 bytes from the middle

        const view = dataView(child);

        // The view should see the child's bytes 4..11 of parent at offsets 0..7.
        expect(view.getUint8(0)).toBe(4);
        expect(view.getUint8(7)).toBe(11);
    });
});
