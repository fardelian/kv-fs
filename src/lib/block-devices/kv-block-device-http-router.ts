import { KvBatchOp, KvBlockDevice, KvBlockDeviceMetadata } from './helpers/kv-block-device';
import { Router } from 'express';

/**
 * Loose runtime shape for one batch op. Stays as `string` for `op` and
 * leaves all other fields optional so we can validate them ourselves at
 * the JSON boundary — narrowing the type up front would let malformed
 * payloads pass straight through.
 */
interface WireBatchOp {
    op: string;
    blockId?: number;
    data?: string;
    start?: number;
    end?: number;
    offset?: number;
}

/**
 * On-the-wire shape of one batch result. `data` is hex-encoded read
 * bytes; `blockId` is the freshly-allocated ID from an `alloc`.
 */
interface WireBatchResult {
    ok: boolean;
    data?: string;
    blockId?: number;
    error?: string;
}

/**
 * Parse `:blockId` and validate it falls inside the device's
 * current capacity. Returns -1 to signal "invalid" (per the
 * codebase convention of using -1 instead of null/undefined for
 * block-device-shaped values). Callers then 400 the request.
 */
const parseBlockId = (blockDevice: KvBlockDevice, id: unknown): number => {
    const blockId = Number(id);
    if (!Number.isInteger(blockId) || blockId < 0 || blockId >= blockDevice.getCapacityBlocks()) {
        return -1;
    }
    return blockId;
};

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
                const body = req.body as { ops?: WireBatchOp[] } | undefined;
                if (!body || !Array.isArray(body.ops)) {
                    res.status(400).json({ error: 'Expected { ops: [...] } JSON body.' });
                    return;
                }

                const ops: KvBatchOp[] = [];
                const requireBlockId = (op: WireBatchOp): boolean => {
                    if (typeof op.blockId !== 'number') {
                        res.status(400).json({ error: 'Each op needs a numeric blockId.' });
                        return false;
                    }
                    return true;
                };

                let aborted = false;
                for (const wireOp of body.ops) {
                    if (wireOp.op === 'alloc') {
                        ops.push({ op: 'alloc' });
                        continue;
                    }
                    if (!requireBlockId(wireOp)) {
                        aborted = true;
                        break;
                    }
                    const blockId = wireOp.blockId!;
                    if (wireOp.op === 'read') {
                        ops.push({ op: 'read', blockId });
                    } else if (wireOp.op === 'write') {
                        if (typeof wireOp.data !== 'string') {
                            res.status(400).json({ error: 'Write op requires hex `data`.' });
                            aborted = true;
                            break;
                        }
                        ops.push({ op: 'write', blockId, data: hexDecode(wireOp.data) });
                    } else if (wireOp.op === 'free') {
                        ops.push({ op: 'free', blockId });
                    } else if (wireOp.op === 'partial-read') {
                        if (typeof wireOp.start !== 'number' || typeof wireOp.end !== 'number') {
                            res.status(400).json({ error: 'partial-read op requires numeric `start` and `end`.' });
                            aborted = true;
                            break;
                        }
                        ops.push({ op: 'partial-read', blockId, start: wireOp.start, end: wireOp.end });
                    } else if (wireOp.op === 'partial-write') {
                        if (typeof wireOp.offset !== 'number') {
                            res.status(400).json({ error: 'partial-write op requires numeric `offset`.' });
                            aborted = true;
                            break;
                        }
                        if (typeof wireOp.data !== 'string') {
                            res.status(400).json({ error: 'partial-write op requires hex `data`.' });
                            aborted = true;
                            break;
                        }
                        ops.push({ op: 'partial-write', blockId, offset: wireOp.offset, data: hexDecode(wireOp.data) });
                    } else {
                        res.status(400).json({ error: `Unknown op: ${wireOp.op}` });
                        aborted = true;
                        break;
                    }
                }
                if (aborted) return;

                const results = await this.blockDevice.batch(ops);
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

                const body = bodyAsBytes(req.body);
                if (body !== undefined && body.length > 0) {
                    await this.blockDevice.writeBlock(blockId, body);
                }

                res.json({ data: { blockId } });
            })

            // DELETE /blocks — wipe every block on the device (i.e.
            // call `this.blockDevice.format()`). Requires the
            // `?confirm=yes` query string as a deliberate-action gate so
            // a stray DELETE can't nuke the device. The exact value has
            // to be `yes` — anything else is rejected.
            .delete('/blocks', async (req, res) => {
                if (req.query.confirm !== 'yes') {
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
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
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
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const partial = parsePartialRange(req.query);
                if (partial === 'invalid') {
                    res.status(400).json({ error: 'Invalid `start` / `end` query parameters.' });
                    return;
                }
                const block = partial
                    ? await this.blockDevice.readBlockPartial(blockId, partial.start, partial.end)
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
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const data = bodyAsBytes(req.body);
                if (data === undefined) {
                    res.status(400).json({ error: 'Expected application/octet-stream body.' });
                    return;
                }
                const offset = parsePartialOffset(req.query);
                if (offset === 'invalid') {
                    res.status(400).json({ error: 'Invalid `offset` query parameter.' });
                    return;
                }
                if (offset === null) {
                    await this.blockDevice.writeBlock(blockId, data);
                } else {
                    await this.blockDevice.writeBlockPartial(blockId, offset, data);
                }
                res.status(204).end();
            })

            // DELETE /blocks/:blockId — free the block. After this,
            // existsBlock will return false until the ID is reallocated.
            .delete('/blocks/:blockId', async (req, res) => {
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                await this.blockDevice.freeBlock(blockId);
                res.status(204).end();
            });
    }
}

/**
 * Best-effort coercion of a request body into a `Uint8Array`. Express's
 * `raw()` middleware delivers a `Buffer`, which is already a `Uint8Array`
 * subclass; absence (`undefined` / empty Buffer) is treated as "no body".
 */
function bodyAsBytes(body: unknown): Uint8Array | undefined {
    if (Buffer.isBuffer(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
    if (body instanceof Uint8Array) {
        return body;
    }
    return undefined;
}

function hexEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

function hexDecode(hex: string): Uint8Array {
    return new Uint8Array(Buffer.from(hex, 'hex'));
}

/**
 * Parse `?start=X&end=Y` from a query string. Returns `null` when
 * neither is present (caller should do a full-block read), an object
 * when both parse cleanly, or `'invalid'` when one is present but
 * malformed (caller should 400). Mixed presence (only one of the two)
 * counts as invalid.
 */
function parsePartialRange(query: unknown): { start: number; end: number } | null | 'invalid' {
    const q = query as { start?: unknown; end?: unknown };
    if (q.start === undefined && q.end === undefined) return null;
    const start = Number(q.start);
    const end = Number(q.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        return 'invalid';
    }
    return { start, end };
}

/**
 * Parse `?offset=X` from a query string. Returns `null` when absent
 * (full-block write), the parsed offset when valid, `'invalid'`
 * otherwise.
 */
function parsePartialOffset(query: unknown): number | null | 'invalid' {
    const q = query as { offset?: unknown };
    if (q.offset === undefined) return null;
    const offset = Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0) return 'invalid';
    return offset;
}
