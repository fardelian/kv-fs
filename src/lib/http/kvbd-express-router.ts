import { KvBlockDevice } from '../block-device/types';
import { Router } from 'express';

export class KvBlockDeviceExpressRouter {
    public route(blockDevice: KvBlockDevice, router: Router): void {
        router
            .put('/blocks', async (req, res) => {
                const nextBlockId = await blockDevice.getNextINodeId();
                res.send({ data: { nextBlockId } });
            })

            .head('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const exists = await blockDevice.existsBlock(blockId);
                res.status(exists ? 200 : 404).end();
            })

            .get('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const block = await blockDevice.readBlock(blockId);
                res.send({ data: { blockData: Array.from(block) } });
            })

            .post('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const data = Buffer.from(req.body.data.blockData);
                await blockDevice.writeBlock(blockId, data);
                res.send({ data: null });
            })

            .delete('/blocks/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                await blockDevice.freeBlock(blockId);
                res.send({ data: null });
            });
    }
}
