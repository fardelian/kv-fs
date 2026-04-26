import { KvBlockDevice, KvBlockDeviceMetadata } from '../helpers/kv-block-device';
import { WireBatchResult } from '../kv-block-device-common/kv-block-device-common';
import { Router } from 'express';
import {
    batchBodySchema,
    blockIdShape,
    bodyBytesSchema,
    formatConfirmSchema,
    hexEncode,
    parseOffsetQuery,
    parseRangeQuery,
    zodMessage,
} from './utils';

/**
 * Wires a `KvBlockDevice` up to an Express router so it can be driven
 * remotely over HTTP. `KvBlockDeviceHttpClient` speaks this same wire
 * protocol on the other side.
 *
 * Block bodies are sent and received as **raw bytes**
 * (`application/octet-stream`), not JSON-encoded number arrays — a 4 KB
 * block crosses the wire as 4 KB, not the ~12 KB it would be as JSON.
 *
 * The mounting application is expected to install
 * `express.raw({ type: 'application/octet-stream', limit: ... })`
 * before this router so block bodies arrive as a `Buffer` on `req.body`.
 *
 * Metadata-only endpoints (`GET /blocks`, `DELETE /blocks?confirm=yes`,
 * `POST /blocks` allocation response, error responses) still use JSON.
 *
 * Every untrusted input — params, query, body — is funnelled through a
 * zod schema (see the `*Schema` consts below) so validation lives in
 * one place per shape and the handlers only see typed, parsed values.
 */
export class KvBlockDeviceHttpRouter {
    private readonly blockDevice: KvBlockDevice;

    constructor(blockDevice: KvBlockDevice) {
        this.blockDevice = blockDevice;
    }

    /** Register every block-device endpoint on the given Express router. */
    public mount(router: Router): void {
        router
            // GET /blocks — return self-describing device metadata so the
            // client can configure its own layout (block size, capacity)
            // without having to be told up-front. The server is the source
            // of truth. `highestBlockId` is a live snapshot of allocation
            // state and changes as blocks are written/freed.
            .get('/blocks', async (_req, res) => {
                const meta: KvBlockDeviceMetadata = {
                    blockSize: this.blockDevice.getBlockSize(),
                    capacityBytes: this.blockDevice.getCapacityBytes(),
                    highestBlockId: await this.blockDevice.getHighestBlockId(),
                };
                res.json({ data: meta });
            })

            // POST /blocks/batch — run many block ops in one round-trip.
            // JSON in (hex-encoded data for writes), JSON out (hex-encoded
            // data for read results). Per-op errors are captured in the
            // result; only fully malformed bodies return non-2xx.
            //
            // Mounted before POST /blocks so the more specific path
            // matches first.
            .post('/blocks/batch', async (req, res) => {
                const parsed = batchBodySchema.safeParse(req.body);
                if (!parsed.success) {
                    res.status(400).json({ error: zodMessage(parsed.error) });
                    return;
                }

                const results = await this.blockDevice.batch(parsed.data.ops);
                const wireResults: WireBatchResult[] = results.map((r) => {
                    if (!r.ok) return { ok: false, error: r.error };
                    const wire: WireBatchResult = { ok: true };
                    if (r.data) wire.data = hexEncode(r.data);
                    if (r.blockId !== undefined) wire.blockId = r.blockId;
                    return wire;
                });
                res.json({ results: wireResults });
            })

            // POST /blocks — allocate a new block ID and (optionally)
            // write its initial bytes. Body is the raw block bytes (or
            // empty for "leave uninitialised"). Returns the allocated
            // `blockId` as JSON.
            .post('/blocks', async (req, res) => {
                const blockId = await this.blockDevice.allocateBlock();

                const body = bodyBytesSchema.safeParse(req.body);
                if (body.success && body.data.length > 0) {
                    await this.blockDevice.writeBlock(blockId, body.data);
                }

                res.json({ data: { blockId } });
            })

            // DELETE /blocks — wipe every block on the device (i.e.
            // call `this.blockDevice.format()`). Requires the
            // `?confirm=yes` query string as a deliberate-action gate so
            // a stray DELETE can't nuke the device. The exact value has
            // to be `yes` — anything else is rejected.
            .delete('/blocks', async (req, res) => {
                if (!formatConfirmSchema.safeParse(req.query).success) {
                    res.status(403).json({ data: {} });
                    return;
                }
                await this.blockDevice.format();
                res.json({ data: { confirm: 'yes' } });
            })

            // HEAD /blocks/:blockId — existence check. 200 = exists, 404 =
            // doesn't, 400 = malformed/out-of-range ID. Cheap because the
            // body is empty.
            .head('/blocks/:blockId', async (req, res) => {
                const blockId = this.parseBlockIdParam(req.params.blockId);
                if (blockId === null) {
                    res.status(400).end();
                    return;
                }
                const exists = await this.blockDevice.existsBlock(blockId);
                res.status(exists ? 200 : 404).end();
            })

            // GET /blocks/:blockId — fetch one block's bytes. Returned
            // raw with `Content-Type: application/octet-stream`.
            //
            // With `?start=X&end=Y` returns only bytes `[start, end)`,
            // delegating to `readBlockPartial`. Both must be present
            // and parseable; missing/invalid → 400.
            .get('/blocks/:blockId', async (req, res) => {
                const blockId = this.parseBlockIdParam(req.params.blockId);
                if (blockId === null) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const range = parseRangeQuery(req.query);
                if (range === 'invalid') {
                    res.status(400).json({ error: 'Invalid `start` / `end` query parameters.' });
                    return;
                }
                const block = range
                    ? await this.blockDevice.readBlockPartial(blockId, range.start, range.end)
                    : await this.blockDevice.readBlock(blockId);
                res.type('application/octet-stream').send(Buffer.from(block));
            })

            // PUT /blocks/:blockId — write one block's bytes. Body is
            // the raw bytes (no envelope).
            //
            // With `?offset=X` splices the body into the existing block
            // starting at `offset`, leaving the surrounding bytes
            // untouched (`writeBlockPartial`).
            .put('/blocks/:blockId', async (req, res) => {
                const blockId = this.parseBlockIdParam(req.params.blockId);
                if (blockId === null) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const body = bodyBytesSchema.safeParse(req.body);
                if (!body.success) {
                    res.status(400).json({ error: 'Expected application/octet-stream body.' });
                    return;
                }
                const offset = parseOffsetQuery(req.query);
                if (offset === 'invalid') {
                    res.status(400).json({ error: 'Invalid `offset` query parameter.' });
                    return;
                }
                if (offset === null) {
                    await this.blockDevice.writeBlock(blockId, body.data);
                } else {
                    await this.blockDevice.writeBlockPartial(blockId, offset, body.data);
                }
                res.status(204).end();
            })

            // DELETE /blocks/:blockId — free the block. After this,
            // existsBlock will return false until the ID is reallocated.
            .delete('/blocks/:blockId', async (req, res) => {
                const blockId = this.parseBlockIdParam(req.params.blockId);
                if (blockId === null) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                await this.blockDevice.freeBlock(blockId);
                res.status(204).end();
            });
    }

    /**
     * Block-ID parameter validation: `blockIdShape` checks integer /
     * non-negative; the capacity bound is checked here because it's
     * read live from the device (capacity may be reconfigured at
     * runtime). Returns `null` on any failure — caller 400s.
     */
    private parseBlockIdParam(raw: unknown): number | null {
        const parsed = blockIdShape.safeParse(raw);
        if (!parsed.success || parsed.data >= this.blockDevice.getCapacityBlocks()) return null;
        return parsed.data;
    }
}
