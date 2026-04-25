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
 * Wires a `Kvthis.blockDevice` up to an Express router so it can be driven
 * remotely over HTTP. `Kvthis.blockDeviceHttpClient` speaks this same wire
 * protocol on the other side.
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
                    capacityBlocks: this.blockDevice.getCapacityBlocks(),
                    highestBlockId: await this.blockDevice.getHighestBlockId(),
                };
                res.send({ data: meta });
            })

            // POST /blocks — allocate a new block ID and (optionally)
            // write data to it in the same round-trip. Body is the same
            // `{ data: { blockData: number[] } }` envelope as PUT
            // /blocks/:blockId; if omitted the new block is left
            // uninitialised. Returns the allocated `blockId`.
            .post('/blocks', async (req, res) => {
                const blockId = await this.blockDevice.allocateBlock();

                const body = req.body as { data?: { blockData?: number[] } } | undefined;
                const blockData = body?.data?.blockData;
                if (blockData !== undefined) {
                    await this.blockDevice.writeBlock(blockId, Uint8Array.from(blockData));
                }

                res.send({ data: { blockId } });
            })

            // DELETE /blocks — wipe every block on the device (i.e.
            // call `this.blockDevice.format()`). Requires the `?yes` query
            // string as a deliberate-action gate so a stray DELETE
            // can't nuke the device. The flag has no value — its mere
            // presence is the confirmation.
            .delete('/blocks', async (req, res) => {
                if (req.query.yes === undefined) {
                    res.status(403).send({ data: {} });
                    return;
                }
                await this.blockDevice.format();
                res.send({ data: { yes: true } });
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

            // GET /blocks/:blockId — fetch one block's bytes. Returned as a
            // JSON array of byte values inside the `{ data: { blockData } }`
            // envelope.
            .get('/blocks/:blockId', async (req, res) => {
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).send({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const block = await this.blockDevice.readBlock(blockId);
                res.send({ data: { blockData: Array.from(block) } });
            })

            // PUT /blocks/:blockId — write one block's bytes. Replaces
            // the block at `:blockId` outright. Body is the mirror of
            // the GET response: `{ data: { blockData: number[] } }`.
            .put('/blocks/:blockId', async (req, res) => {
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).send({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                const body = req.body as { data: { blockData: number[] } };
                const data = Uint8Array.from(body.data.blockData);
                await this.blockDevice.writeBlock(blockId, data);
                res.send({ data: null });
            })

            // DELETE /blocks/:blockId — free the block. After this,
            // existsBlock will return false until the ID is reallocated.
            .delete('/blocks/:blockId', async (req, res) => {
                const blockId = parseBlockId(this.blockDevice, req.params.blockId);
                if (blockId === -1) {
                    res.status(400).send({ error: `Invalid block ID: ${req.params.blockId}` });
                    return;
                }
                await this.blockDevice.freeBlock(blockId);
                res.send({ data: null });
            });
    }
}
