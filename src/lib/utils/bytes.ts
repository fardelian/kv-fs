/** Wrap a `Uint8Array` in a `DataView` over the same memory (no copy). */
export function dataView(buf: Uint8Array): DataView {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Concatenate `Uint8Array`s into a fresh single buffer. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) total += p.length;

    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/** UTF-8 encode a string into a `Uint8Array`. */
export function utf8Encode(s: string): Uint8Array {
    return new TextEncoder().encode(s);
}

/** UTF-8 decode a `Uint8Array` (or a slice of one) into a string. */
export function utf8Decode(buf: Uint8Array, start?: number, end?: number): string {
    const slice = start === undefined && end === undefined ? buf : buf.subarray(start, end);
    return new TextDecoder('utf-8').decode(slice);
}
