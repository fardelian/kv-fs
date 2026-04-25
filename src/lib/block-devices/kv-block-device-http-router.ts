import { KvBlockDevice, KvBlockDeviceMetadata } from './helpers/kv-block-device';
import { Router } from 'express';

// Parse `:blockId` and validate it falls inside the device's
// current capacity. Returns -1 to signal "invalid" (per the
// codebase convention of using -1 instead of null/undefined for
// block-device-shaped values). Callers then 400 the request.
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
            .get('/blocks/:blockId', async (req, res) => {
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).json({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const block = await this.blockDevice.readBlock(blockId);
                res.type('application/octet-stream').send(Buffer.from(block));
            })

            // PUT /blocks/:blockId — write one block's bytes. Body is
            // the raw bytes (no envelope).
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
                await this.blockDevice.writeBlock(blockId, data);
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
