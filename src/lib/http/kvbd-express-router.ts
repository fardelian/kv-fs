import { KvBlockDevice } from '../block-device/types';
import { Router } from 'express';

export class KvBlockDeviceExpressRouter {
    public route(blockDevice: KvBlockDevice, router: Router): Router {
        return router
            .get('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const block = await blockDevice.readBlock(blockId);
                res.send(block);
            })

            .post('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const data = req.body;
                await blockDevice.writeBlock(blockId, data);
                res.send();
            })

            .delete('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                await blockDevice.freeBlock(blockId);
                res.send();
            })

            .head('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const exists = await blockDevice.existsBlock(blockId);
                res.send(exists ? 200 : 404);
            });
    }
}
