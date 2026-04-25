import { describe, it, expect } from '@jest/globals';
import { faker } from '@faker-js/faker';
import { KvBlockDeviceHttpRouter } from './kv-block-device-http-router';
import { MockBlockDevice } from '../../mocks/kv-block-device.mock';
import type { Router } from 'express';

type Handler = (req: FakeReq, res: FakeRes) => Promise<void> | void;

interface CapturedRoute {
    method: string;
    path: string;
    handler: Handler;
}

interface FakeReq {
    params: Record<string, string>;
    query: Record<string, unknown>;
    body?: unknown;
}

class FakeRes {
    public statusCode = 200;
    public body: unknown = undefined;
    public ended = false;

    public status = (code: number): this => {
        this.statusCode = code;
        return this;
    };

    public send = (body: unknown): this => {
        this.body = body;
        return this;
    };

    public end = (): this => {
        this.ended = true;
        return this;
    };
}

class FakeRouter {
    public routes: CapturedRoute[] = [];

    public get = (path: string, handler: Handler): this => this.register('GET', path, handler);
    public post = (path: string, handler: Handler): this => this.register('POST', path, handler);
    public put = (path: string, handler: Handler): this => this.register('PUT', path, handler);
    public delete = (path: string, handler: Handler): this => this.register('DELETE', path, handler);
    public head = (path: string, handler: Handler): this => this.register('HEAD', path, handler);

    public find(method: string, path: string): Handler {
        const route = this.routes.find((r) => r.method === method && r.path === path);
        if (!route) throw new Error(`No route registered for ${method} ${path}`);
        return route.handler;
    }

    private register(method: string, path: string, handler: Handler): this {
        this.routes.push({ method, path, handler });
        return this;
    }
}

const BLOCK_SIZE = 4096;
const CAPACITY_BYTES = BLOCK_SIZE * 16;

function makeRouter() {
    const blockDevice = new MockBlockDevice(BLOCK_SIZE, CAPACITY_BYTES);
    const fakeRouter = new FakeRouter();
    new KvBlockDeviceHttpRouter(blockDevice).mount(fakeRouter as unknown as Router);
    return { blockDevice, fakeRouter };
}

async function invoke(router: FakeRouter, method: string, path: string, req: Partial<FakeReq> = {}): Promise<FakeRes> {
    const handler = router.find(method, path);
    const fullReq: FakeReq = { params: req.params ?? {}, query: req.query ?? {}, body: req.body };
    const res = new FakeRes();
    await handler(fullReq, res);
    return res;
}

describe('KvBlockDeviceHttpRouter', () => {
    describe('GET /blocks (metadata)', () => {
        it('returns blockSize, capacityBytes, and the live highestBlockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.getHighestBlockId.mockResolvedValueOnce(7);

            const res = await invoke(fakeRouter, 'GET', '/blocks');

            expect(res.body).toEqual({
                data: {
                    blockSize: BLOCK_SIZE,
                    capacityBytes: CAPACITY_BYTES,
                    highestBlockId: 7,
                },
            });
        });
    });

    describe('POST /blocks (allocate, optionally write)', () => {
        it('returns the allocated blockId and does not write when no body is provided', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(3);

            const res = await invoke(fakeRouter, 'POST', '/blocks');

            expect(res.body).toEqual({ data: { blockId: 3 } });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });

        it('writes the body data to the newly allocated block when blockData is provided', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(11);
            blockDevice.writeBlock.mockResolvedValueOnce(undefined);

            const res = await invoke(fakeRouter, 'POST', '/blocks', {
                body: { data: { blockData: [1, 2, 3, 4] } },
            });

            expect(res.body).toEqual({ data: { blockId: 11 } });
            expect(blockDevice.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenData] = blockDevice.writeBlock.mock.calls[0];
            expect(writtenId).toBe(11);
            expect(Array.from(writtenData)).toEqual([1, 2, 3, 4]);
        });

        it('does not write when the body has no data field', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(0);

            await invoke(fakeRouter, 'POST', '/blocks', { body: {} });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();

            await invoke(fakeRouter, 'POST', '/blocks', { body: { data: {} } });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });
    });

    describe('DELETE /blocks (format)', () => {
        it('rejects with 403 when ?confirm is missing', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'DELETE', '/blocks', { query: {} });

            expect(res.statusCode).toBe(403);
            expect(blockDevice.format).not.toHaveBeenCalled();
        });

        it('rejects with 403 when ?confirm has the wrong value', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'DELETE', '/blocks', { query: { confirm: 'no' } });

            expect(res.statusCode).toBe(403);
            expect(blockDevice.format).not.toHaveBeenCalled();
        });

        it('formats the device when ?confirm=yes is supplied', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.format.mockResolvedValueOnce(undefined);

            const res = await invoke(fakeRouter, 'DELETE', '/blocks', { query: { confirm: 'yes' } });

            expect(blockDevice.format).toHaveBeenCalledTimes(1);
            expect(res.body).toEqual({ data: { confirm: 'yes' } });
        });
    });

    describe('HEAD /blocks/:blockId (existence check)', () => {
        it('returns 200 when the block exists', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.existsBlock.mockResolvedValueOnce(true);

            const res = await invoke(fakeRouter, 'HEAD', '/blocks/:blockId', { params: { blockId: '3' } });

            expect(res.statusCode).toBe(200);
            expect(res.ended).toBe(true);
        });

        it('returns 404 when the block does not exist', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.existsBlock.mockResolvedValueOnce(false);

            const res = await invoke(fakeRouter, 'HEAD', '/blocks/:blockId', { params: { blockId: '3' } });

            expect(res.statusCode).toBe(404);
            expect(res.ended).toBe(true);
        });

        it.each([['not-a-number'], ['-1'], ['1.5'], [String(BLOCK_SIZE * 16 + 1)]])(
            'returns 400 for invalid blockId %j',
            async (invalid) => {
                const { blockDevice, fakeRouter } = makeRouter();

                const res = await invoke(fakeRouter, 'HEAD', '/blocks/:blockId', { params: { blockId: invalid } });

                expect(res.statusCode).toBe(400);
                expect(blockDevice.existsBlock).not.toHaveBeenCalled();
            },
        );
    });

    describe('GET /blocks/:blockId (read)', () => {
        it('returns the block bytes as a JSON number array', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            const expected = new Uint8Array([10, 20, 30]);
            blockDevice.readBlock.mockResolvedValueOnce(expected);

            const res = await invoke(fakeRouter, 'GET', '/blocks/:blockId', { params: { blockId: '5' } });

            expect(blockDevice.readBlock).toHaveBeenCalledWith(5);
            expect(res.body).toEqual({ data: { blockData: [10, 20, 30] } });
        });

        it('returns 400 with an error message for an invalid blockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'GET', '/blocks/:blockId', { params: { blockId: 'oops' } });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid block ID: oops' });
            expect(blockDevice.readBlock).not.toHaveBeenCalled();
        });
    });

    describe('PUT /blocks/:blockId (write)', () => {
        it('writes the body data to the requested block', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.writeBlock.mockResolvedValueOnce(undefined);

            const res = await invoke(fakeRouter, 'PUT', '/blocks/:blockId', {
                params: { blockId: '4' },
                body: { data: { blockData: [9, 8, 7] } },
            });

            expect(blockDevice.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenData] = blockDevice.writeBlock.mock.calls[0];
            expect(writtenId).toBe(4);
            expect(Array.from(writtenData)).toEqual([9, 8, 7]);
            expect(res.body).toEqual({ data: null });
        });

        it('returns 400 with an error message for an invalid blockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'PUT', '/blocks/:blockId', {
                params: { blockId: 'bad' },
                body: { data: { blockData: [] } },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid block ID: bad' });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });
    });

    describe('DELETE /blocks/:blockId (free)', () => {
        it('frees the block at the given id', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.freeBlock.mockResolvedValueOnce(undefined);
            const blockId = faker.number.int({ min: 0, max: 15 });

            const res = await invoke(fakeRouter, 'DELETE', '/blocks/:blockId', {
                params: { blockId: String(blockId) },
            });

            expect(blockDevice.freeBlock).toHaveBeenCalledWith(blockId);
            expect(res.body).toEqual({ data: null });
        });

        it('returns 400 with an error message for an invalid blockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'DELETE', '/blocks/:blockId', {
                params: { blockId: 'NaN' },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid block ID: NaN' });
            expect(blockDevice.freeBlock).not.toHaveBeenCalled();
        });
    });
});
