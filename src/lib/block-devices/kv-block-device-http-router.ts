import { KvBlockDevice, KvBlockDeviceMetadata } from './helpers/kv-block-device';
import { Router } from 'express';

/**
 * Wires a `KvBlockDevice` up to an Express router so it can be driven
 * remotely over HTTP. `KvBlockDeviceHttpClient` speaks this same wire
 * protocol on the other side.
 */
export class KvBlockDeviceHttpRouter {
    public route(blockDevice: KvBlockDevice, router: Router): void {
        router
            // GET /blocks — return self-describing device metadata so the
            // client can configure its own layout (block size, capacity)
            // without having to be told up-front. The server is the source
            // of truth.
            .get('/blocks', (_req, res) => {
                const meta: KvBlockDeviceMetadata = {
                    blockSize: blockDevice.getBlockSize(),
                    maxBlockId: blockDevice.getMaxBlockId(),
                };
                res.send({ data: meta });
            })

            // PUT /blocks — allocate a new block ID. Returns the ID the
            // device picked; the caller is then expected to POST data to
            // it (or treat the allocation as reserved).
            .put('/blocks', async (_req, res) => {
                const nextBlockId = await blockDevice.allocateBlock();
                res.send({ data: { nextBlockId } });
            })

            // HEAD /blocks/:blockId — existence check. 200 = exists, 404 =
            // doesn't. Cheap because the body is empty.
            .head('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const exists = await blockDevice.existsBlock(blockId);
                res.status(exists ? 200 : 404).end();
            })

            // GET /blocks/:blockId — fetch one block's bytes. Returned as a
            // JSON array of byte values inside the `{ data: { blockData } }`
            // envelope.
            .get('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const block = await blockDevice.readBlock(blockId);
                res.send({ data: { blockData: Array.from(block) } });
            })

            // POST /blocks/:blockId — write one block's bytes. Body is the
            // mirror of the GET response: `{ data: { blockData: number[] } }`.
            .post('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const body = req.body as { data: { blockData: number[] } };
                const data = Uint8Array.from(body.data.blockData);
                await blockDevice.writeBlock(blockId, data);
                res.send({ data: null });
            })

            // DELETE /blocks/:blockId — free the block. After this,
            // existsBlock should return false until the ID is reallocated.
            .delete('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                await blockDevice.freeBlock(blockId);
                res.send({ data: null });
            });
    }
}
