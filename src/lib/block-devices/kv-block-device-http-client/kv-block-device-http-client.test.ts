import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { KvBlockDeviceHttpClient } from './kv-block-device-http-client';
import { KvError_BD_Overflow } from '../../utils';

const BASE_URL = 'http://kv-fs.test';
const SERVER_BLOCK_SIZE = 4096;
const SERVER_CAPACITY_BYTES = SERVER_BLOCK_SIZE * 32;

interface FakeJsonResponseInit {
    status?: number;
    body: unknown;
}

interface FakeBytesResponseInit {
    status?: number;
    bytes: Uint8Array;
}

function jsonResponse({ status = 200, body }: FakeJsonResponseInit): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        arrayBuffer: async () => { throw new Error('fakeJson Response has no body'); },
    } as unknown as Response;
}

function bytesResponse({ status = 200, bytes }: FakeBytesResponseInit): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => { throw new Error('fakeBytes Response is not JSON'); },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
}

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<typeof fetch>();

beforeEach(() => {
    mockFetch.mockReset();
    // Cast through `unknown` to swap the function reference: `typeof fetch`
    // on some runtimes carries extra static properties the mock doesn't
    // model, and a direct assignment trips the structural type check.
    (globalThis as unknown as { fetch: unknown }).fetch = mockFetch;
});

afterEach(() => {
    (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
});

/** Make a `metadata` response that init() reads on first contact. */
function metadataResponse(highestBlockId = -1): Response {
    return jsonResponse({
        body: {
            data: {
                blockSize: SERVER_BLOCK_SIZE,
                capacityBytes: SERVER_CAPACITY_BYTES,
                highestBlockId,
            },
        },
    });
}

describe('KvBlockDeviceHttpClient', () => {
    describe('init / metadata', () => {
        it('reads blockSize and capacityBytes from the server on init', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.init();

            expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/blocks`, undefined);
            expect(client.getBlockSize()).toBe(SERVER_BLOCK_SIZE);
            expect(client.getCapacityBytes()).toBe(SERVER_CAPACITY_BYTES);
        });

        it('throws when the server returns a non-2xx status', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 500, body: {} }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);

            await expect(client.init()).rejects.toThrow(/status 500/);
        });

        it('starts with placeholder 0/0 dimensions before init', () => {
            const client = new KvBlockDeviceHttpClient(BASE_URL);

            expect(client.getBlockSize()).toBe(0);
            expect(client.getCapacityBytes()).toBe(0);
        });
    });

    describe('readBlock', () => {
        it('GETs /blocks/:blockId and decodes the raw byte response', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(bytesResponse({ bytes: new Uint8Array([0xab, 0xcd, 0xef]) }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const result = await client.readBlock(7);

            expect(mockFetch).toHaveBeenLastCalledWith(`${BASE_URL}/blocks/7`, undefined);
            expect(Array.from(result)).toEqual([0xab, 0xcd, 0xef]);
        });

        it('propagates errors when the server responds non-2xx', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 404, body: {} }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);

            await expect(client.readBlock(0)).rejects.toThrow(/status 404/);
        });
    });

    describe('writeBlock', () => {
        it('PUTs /blocks/:blockId with raw bytes in the body, padded to blockSize', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 204, body: null }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.writeBlock(2, new Uint8Array([1, 2, 3]));

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks/2`);
            const reqInit = init!;
            expect(reqInit.method).toBe('PUT');
            expect(reqInit.headers).toEqual({ 'Content-Type': 'application/octet-stream' });

            const body = reqInit.body;
            expect(body).toBeInstanceOf(Uint8Array);
            const bytes = body as Uint8Array;
            expect(bytes.length).toBe(SERVER_BLOCK_SIZE);
            expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 2, 3]);
            for (let i = 3; i < SERVER_BLOCK_SIZE; i++) {
                expect(bytes[i]).toBe(0);
            }
        });

        it('throws KvError_BD_Overflow when data exceeds blockSize', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const oversize = new Uint8Array(SERVER_BLOCK_SIZE + 1);

            await expect(client.writeBlock(0, oversize))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('freeBlock', () => {
        it('issues DELETE /blocks/:blockId', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 204, body: null }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.freeBlock(9);

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks/9`);
            expect(init!.method).toBe('DELETE');
        });
    });

    describe('existsBlock', () => {
        it('returns true when HEAD /blocks/:blockId returns 200', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 200, body: {} }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            expect(await client.existsBlock(0)).toBe(true);
        });

        it('returns false when HEAD /blocks/:blockId returns 404', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 404, body: {} }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            expect(await client.existsBlock(0)).toBe(false);
        });
    });

    describe('allocateBlock', () => {
        it('POSTs /blocks and returns the server-assigned id', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ body: { data: { blockId: 17 } } }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const id = await client.allocateBlock();

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks`);
            expect(init!.method).toBe('POST');
            expect(id).toBe(17);
        });
    });

    describe('getHighestBlockId', () => {
        it('re-fetches the metadata and returns the live highestBlockId', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse(-1));
            mockFetch.mockResolvedValueOnce(metadataResponse(42));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const result = await client.getHighestBlockId();

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(result).toBe(42);
        });
    });

    describe('batch', () => {
        it('POSTs /blocks/batch with hex-encoded write payloads and decodes hex read responses', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({
                body: {
                    results: [
                        { ok: true, data: 'aabb' },
                        { ok: true },
                        { ok: false, error: 'gone' },
                        { ok: false }, // exercises the "unknown error" fallback
                    ],
                },
            }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const results = await client.batch([
                { op: 'read', blockId: 1 },
                { op: 'write', blockId: 2, data: new Uint8Array([0x01, 0x02, 0x03]) },
                { op: 'free', blockId: 3 },
                { op: 'read', blockId: 4 },
            ]);

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks/batch`);
            expect(init!.method).toBe('POST');
            expect(init!.headers).toEqual({ 'Content-Type': 'application/json' });
            const sentBody = JSON.parse(init!.body as string) as { ops: { op: string; blockId: number; data?: string }[] };
            expect(sentBody.ops).toEqual([
                { op: 'read', blockId: 1 },
                { op: 'write', blockId: 2, data: '010203' },
                { op: 'free', blockId: 3 },
                { op: 'read', blockId: 4 },
            ]);

            expect(results[0]).toEqual({ ok: true, data: new Uint8Array([0xaa, 0xbb]) });
            expect(results[1]).toEqual({ ok: true });
            expect(results[2]).toEqual({ ok: false, error: 'gone' });
            expect(results[3]).toEqual({ ok: false, error: 'unknown error' });
        });

        it('encodes alloc / partial-read / partial-write ops and decodes their results', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({
                body: {
                    results: [
                        { ok: true, blockId: 13 }, // alloc
                        { ok: true, data: '0102' }, // partial-read
                        { ok: true }, // partial-write
                    ],
                },
            }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const results = await client.batch([
                { op: 'alloc' },
                { op: 'partial-read', blockId: 5, start: 10, end: 12 },
                { op: 'partial-write', blockId: 7, offset: 30, data: new Uint8Array([0xff]) },
            ]);

            const sentBody = JSON.parse(mockFetch.mock.calls[1][1]!.body as string) as {
                ops: { op: string; blockId?: number; data?: string; start?: number; end?: number; offset?: number }[];
            };
            expect(sentBody.ops).toEqual([
                { op: 'alloc' },
                { op: 'partial-read', blockId: 5, start: 10, end: 12 },
                { op: 'partial-write', blockId: 7, offset: 30, data: 'ff' },
            ]);

            expect(results[0]).toEqual({ ok: true, blockId: 13 });
            expect(results[1]).toEqual({ ok: true, data: new Uint8Array([0x01, 0x02]) });
            expect(results[2]).toEqual({ ok: true });
        });
    });

    describe('readBlockPartial', () => {
        it('issues GET /blocks/:id?start=X&end=Y and decodes the raw byte response', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(bytesResponse({ bytes: new Uint8Array([0x10, 0x11, 0x12]) }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const result = await client.readBlockPartial(7, 100, 103);

            expect(mockFetch).toHaveBeenLastCalledWith(`${BASE_URL}/blocks/7?start=100&end=103`, undefined);
            expect(Array.from(result)).toEqual([0x10, 0x11, 0x12]);
        });

        it('returns an empty buffer without hitting the wire when end <= start', async () => {
            // Single mock for the @Init auto-init; the empty-range path
            // short-circuits before any HTTP request, so no second mock
            // is needed.
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const result = await client.readBlockPartial(0, 5, 5);

            expect(result.length).toBe(0);
            // Exactly one fetch: the @Init auto-init. No partial fetch.
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('writeBlockPartial', () => {
        it('PUTs /blocks/:id?offset=X with the raw partial data as the body', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 204, body: null }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.writeBlockPartial(2, 50, new Uint8Array([0xa, 0xb, 0xc]));

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks/2?offset=50`);
            const reqInit = init!;
            expect(reqInit.method).toBe('PUT');
            expect(reqInit.headers).toEqual({ 'Content-Type': 'application/octet-stream' });

            const body = reqInit.body as Uint8Array;
            expect(body).toBeInstanceOf(Uint8Array);
            expect(Array.from(body)).toEqual([0xa, 0xb, 0xc]);
        });

        it('is a no-op when data is empty', async () => {
            // Single mock for the @Init auto-init; the empty-data path
            // short-circuits before any HTTP request.
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.writeBlockPartial(0, 0, new Uint8Array(0));

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('throws KvError_BD_Overflow when offset + data exceeds blockSize', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const oversize = new Uint8Array(SERVER_BLOCK_SIZE);

            await expect(client.writeBlockPartial(0, 1, oversize))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
        });
    });

    describe('format', () => {
        it('issues DELETE /blocks?confirm=yes (does not require init)', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ body: { data: { confirm: 'yes' } } }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.format();

            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe(`${BASE_URL}/blocks?confirm=yes`);
            expect(init!.method).toBe('DELETE');
        });

        it('throws when the server responds non-2xx', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ status: 403, body: {} }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await expect(client.format()).rejects.toThrow(/status 403/);
        });
    });
});
