import { describe, it, expect } from 'bun:test';
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
    public contentType: string | undefined;

    public status = (code: number): this => {
        this.statusCode = code;
        return this;
    };

    public json = (body: unknown): this => {
        this.body = body;
        this.contentType = 'application/json';
        return this;
    };

    public send = (body: unknown): this => {
        this.body = body;
        return this;
    };

    public type = (mime: string): this => {
        this.contentType = mime;
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

    describe('POST /blocks (allocate, optionally write raw bytes)', () => {
        it('returns the allocated blockId and does not write when no body is provided', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(3);

            const res = await invoke(fakeRouter, 'POST', '/blocks');

            expect(res.body).toEqual({ data: { blockId: 3 } });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });

        it('writes the raw body bytes to the newly allocated block when body is non-empty', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(11);
            blockDevice.writeBlock.mockResolvedValueOnce(undefined);

            const bodyBytes = Buffer.from([1, 2, 3, 4]);
            const res = await invoke(fakeRouter, 'POST', '/blocks', { body: bodyBytes });

            expect(res.body).toEqual({ data: { blockId: 11 } });
            expect(blockDevice.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenData] = blockDevice.writeBlock.mock.calls[0];
            expect(writtenId).toBe(11);
            expect(Array.from(writtenData)).toEqual([1, 2, 3, 4]);
        });

        it('does not write when body is an empty Buffer', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(0);

            await invoke(fakeRouter, 'POST', '/blocks', { body: Buffer.alloc(0) });

            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });

        it('does not write when there is no body at all', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.allocateBlock.mockResolvedValueOnce(0);

            await invoke(fakeRouter, 'POST', '/blocks', {});

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

    describe('GET /blocks/:blockId (raw read)', () => {
        it('returns the block bytes as application/octet-stream', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            const expected = new Uint8Array([10, 20, 30]);
            blockDevice.readBlock.mockResolvedValueOnce(expected);

            const res = await invoke(fakeRouter, 'GET', '/blocks/:blockId', { params: { blockId: '5' } });

            expect(blockDevice.readBlock).toHaveBeenCalledWith(5);
            expect(res.contentType).toBe('application/octet-stream');
            expect(Buffer.isBuffer(res.body)).toBe(true);
            expect(Array.from(res.body as Buffer)).toEqual([10, 20, 30]);
        });

        it('returns 400 with an error message for an invalid blockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'GET', '/blocks/:blockId', { params: { blockId: 'oops' } });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid block ID: oops' });
            expect(blockDevice.readBlock).not.toHaveBeenCalled();
        });
    });

    describe('PUT /blocks/:blockId (raw write)', () => {
        it('writes the raw body bytes to the requested block and returns 204', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.writeBlock.mockResolvedValueOnce(undefined);

            const res = await invoke(fakeRouter, 'PUT', '/blocks/:blockId', {
                params: { blockId: '4' },
                body: Buffer.from([9, 8, 7]),
            });

            expect(blockDevice.writeBlock).toHaveBeenCalledTimes(1);
            const [writtenId, writtenData] = blockDevice.writeBlock.mock.calls[0];
            expect(writtenId).toBe(4);
            expect(Array.from(writtenData)).toEqual([9, 8, 7]);
            expect(res.statusCode).toBe(204);
        });

        it('returns 400 when the body is missing or not a Buffer', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'PUT', '/blocks/:blockId', {
                params: { blockId: '4' },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Expected application/octet-stream body.' });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });

        it('returns 400 with an error message for an invalid blockId', async () => {
            const { blockDevice, fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'PUT', '/blocks/:blockId', {
                params: { blockId: 'bad' },
                body: Buffer.from([]),
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Invalid block ID: bad' });
            expect(blockDevice.writeBlock).not.toHaveBeenCalled();
        });
    });

    describe('POST /blocks/batch', () => {
        it('runs read/write/free ops via the device and returns hex-encoded read results', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.readBlock.mockResolvedValueOnce(new Uint8Array([0xaa, 0xbb]));
            blockDevice.writeBlock.mockResolvedValueOnce(undefined);
            blockDevice.freeBlock.mockResolvedValueOnce(undefined);

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', {
                body: {
                    ops: [
                        { op: 'read', blockId: 1 },
                        { op: 'write', blockId: 2, data: '010203' },
                        { op: 'free', blockId: 3 },
                    ],
                },
            });

            expect(blockDevice.readBlock).toHaveBeenCalledWith(1);
            const [writeId, writeData] = blockDevice.writeBlock.mock.calls[0];
            expect(writeId).toBe(2);
            expect(Array.from(writeData)).toEqual([0x01, 0x02, 0x03]);
            expect(blockDevice.freeBlock).toHaveBeenCalledWith(3);

            expect(res.body).toEqual({
                results: [
                    { ok: true, data: 'aabb' },
                    { ok: true },
                    { ok: true },
                ],
            });
        });

        it('captures per-op errors as { ok: false, error }', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.readBlock.mockRejectedValueOnce(new Error('disk gone'));

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', {
                body: { ops: [{ op: 'read', blockId: 0 }] },
            });

            expect(res.body).toEqual({ results: [{ ok: false, error: 'disk gone' }] });
        });

        it('returns 400 when the body is not a JSON object with an ops array', async () => {
            const { fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', { body: undefined });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Expected { ops: [...] } JSON body.' });
        });

        it('returns 400 when ops is not an array', async () => {
            const { fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', { body: { ops: 'not-array' } });

            expect(res.statusCode).toBe(400);
        });

        it('returns 400 when an op is missing a numeric blockId', async () => {
            const { fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', {
                body: { ops: [{ op: 'read', blockId: 'oops' }] },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Each op needs a numeric blockId.' });
        });

        it('returns 400 when a write op is missing the hex data field', async () => {
            const { fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', {
                body: { ops: [{ op: 'write', blockId: 0 }] },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Write op requires hex `data`.' });
        });

        it('returns 400 for an unknown op kind', async () => {
            const { fakeRouter } = makeRouter();

            const res = await invoke(fakeRouter, 'POST', '/blocks/batch', {
                body: { ops: [{ op: 'unknown', blockId: 0 }] },
            });

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: 'Unknown op: unknown' });
        });
    });

    describe('DELETE /blocks/:blockId (free)', () => {
        it('frees the block at the given id and returns 204', async () => {
            const { blockDevice, fakeRouter } = makeRouter();
            blockDevice.freeBlock.mockResolvedValueOnce(undefined);
            const blockId = faker.number.int({ min: 0, max: 15 });

            const res = await invoke(fakeRouter, 'DELETE', '/blocks/:blockId', {
                params: { blockId: String(blockId) },
            });

            expect(blockDevice.freeBlock).toHaveBeenCalledWith(blockId);
            expect(res.statusCode).toBe(204);
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
