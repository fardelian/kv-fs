import { KvBlockDevice } from '../block-device/types';
import { Router } from 'express';

export class KvBlockDeviceExpress {
    private readonly blockDevice: KvBlockDevice;
    private readonly router: Router;

    constructor(
        blockDevice: KvBlockDevice,
        router: Router,
    ) {
        this.blockDevice = blockDevice;
        this.router = router;
    }

    public getRouter(): Router {
        return this.router
            .get('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const block = await this.blockDevice.readBlock(blockId);
                res.send(block);
            })

            .post('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const data = req.body;
                await this.blockDevice.writeBlock(blockId, data);
                res.send();
            })

            .delete('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                await this.blockDevice.freeBlock(blockId);
                res.send();
            })

            .head('/block/:blockId', async (req, res) => {
                const blockId = Number(req.params.blockId) | 0;
                const exists = await this.blockDevice.existsBlock(blockId);
                res.send(exists ? 200 : 404);
            });
    }
}
