export function hexEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

export function hexDecode(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}
