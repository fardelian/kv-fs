/**
 * Wire-protocol types shared by [`KvBlockDeviceHttpClient`](kv-block-device-http-client.ts)
 * (the encoder) and [`KvBlockDeviceHttpRouter`](kv-block-device-http-router.ts)
 * (the decoder). Putting them in one file keeps the two ends from
 * drifting apart — every wire-level field is declared exactly once.
 *
 * `WireBatchOp` is a discriminated union mirroring `KvBatchOp`, so
 * TypeScript catches shape mistakes on the encoder side at compile
 * time (e.g. a `write` op without `data`). The decoder still has to
 * narrow defensively at the JSON boundary because the input is
 * untrusted, but the union spells out exactly which shapes are valid.
 *
 * `data` is hex-encoded for transport because the wire envelope is
 * JSON; raw block bytes go via the dedicated
 * `application/octet-stream` endpoints (`GET` / `PUT /blocks/:id`)
 * and never inside the batch payload.
 */

export type WireBatchOp
    = { op: 'read'; blockId: number }
        | { op: 'write'; blockId: number; data: string }
        | { op: 'free'; blockId: number }
        | { op: 'alloc' }
        | { op: 'partial-read'; blockId: number; start: number; end: number }
        | { op: 'partial-write'; blockId: number; offset: number; data: string };

/**
 * On-the-wire shape of one batch result. `data` carries hex-encoded
 * read bytes (for `read` / `partial-read`); `blockId` carries the
 * freshly-allocated ID for `alloc`. Loose because a single shape
 * covers every op variant — callers narrow by knowing which op they
 * sent.
 */
export interface WireBatchResult {
    ok: boolean;
    data?: string;
    blockId?: number;
    error?: string;
}
