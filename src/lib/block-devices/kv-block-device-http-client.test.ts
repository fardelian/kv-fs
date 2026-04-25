import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { KvBlockDeviceHttpClient } from './kv-block-device-http-client';
import { KvError_BD_Overflow } from '../utils';

const BASE_URL = 'http://kv-fs.test';
const SERVER_BLOCK_SIZE = 4096;
const SERVER_CAPACITY_BYTES = SERVER_BLOCK_SIZE * 32;

interface FakeResponseInit {
    status?: number;
    body?: unknown;
}

function fakeResponse({ status = 200, body }: FakeResponseInit): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as unknown as Response;
}

const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<typeof fetch>();

beforeEach(() => {
    mockFetch.mockReset();
    (globalThis as { fetch: typeof fetch }).fetch = mockFetch;
});

afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

/** Make a `metadata` response that init() reads on first contact. */
function metadataResponse(highestBlockId = -1): Response {
    return fakeResponse({
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
            mockFetch.mockResolvedValueOnce(fakeResponse({ status: 500 }));

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
        it('GETs /blocks/:blockId and decodes the JSON byte array', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ body: { data: { blockData: [0xab, 0xcd, 0xef] } } }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const result = await client.readBlock(7);

            expect(mockFetch).toHaveBeenLastCalledWith(`${BASE_URL}/blocks/7`, undefined);
            expect(Array.from(result)).toEqual([0xab, 0xcd, 0xef]);
        });

        it('propagates errors when the server responds non-2xx', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ status: 404 }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);

            await expect(client.readBlock(0)).rejects.toThrow(/status 404/);
        });
    });

    describe('writeBlock', () => {
        it('PUTs /blocks/:blockId with a JSON body, padding to blockSize', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ body: { data: null } }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.writeBlock(2, new Uint8Array([1, 2, 3]));

            const [url, init] = mockFetch.mock.calls[1];
            expect(url).toBe(`${BASE_URL}/blocks/2`);
            const reqInit = init!;
            expect(reqInit.method).toBe('PUT');
            expect(reqInit.headers).toEqual({ 'Content-Type': 'application/json' });

            const body = JSON.parse(reqInit.body as string) as { data: { blockData: number[] } };
            expect(body.data.blockData.length).toBe(SERVER_BLOCK_SIZE);
            expect(body.data.blockData.slice(0, 3)).toEqual([1, 2, 3]);
            for (let i = 3; i < SERVER_BLOCK_SIZE; i++) {
                expect(body.data.blockData[i]).toBe(0);
            }
        });

        it('throws KvError_BD_Overflow when data exceeds blockSize', async () => {
            // The @Init wrapper triggers init() lazily on the first
            // decorated call — set up exactly one metadata response, then
            // call writeBlock directly. The size check fires before any
            // network I/O, so no PUT should be issued.
            mockFetch.mockResolvedValueOnce(metadataResponse());

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            const oversize = new Uint8Array(SERVER_BLOCK_SIZE + 1);

            await expect(client.writeBlock(0, oversize))
                .rejects.toBeInstanceOf(KvError_BD_Overflow);
            // Only the metadata fetch happened; no PUT issued.
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    describe('freeBlock', () => {
        it('issues DELETE /blocks/:blockId', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ body: { data: null } }));

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
            mockFetch.mockResolvedValueOnce(fakeResponse({ status: 200 }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            expect(await client.existsBlock(0)).toBe(true);
        });

        it('returns false when HEAD /blocks/:blockId returns 404', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ status: 404 }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            expect(await client.existsBlock(0)).toBe(false);
        });
    });

    describe('allocateBlock', () => {
        it('POSTs /blocks and returns the server-assigned id', async () => {
            mockFetch.mockResolvedValueOnce(metadataResponse());
            mockFetch.mockResolvedValueOnce(fakeResponse({ body: { data: { blockId: 17 } } }));

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

            // Two metadata fetches: one for init, one for the live read.
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(result).toBe(42);
        });
    });

    describe('format', () => {
        it('issues DELETE /blocks?yes (does not require init)', async () => {
            // format() does NOT have @Init — it can run without first
            // calling init(). Single fetch call expected.
            mockFetch.mockResolvedValueOnce(fakeResponse({ body: { data: { yes: true } } }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await client.format();

            const [url, init] = mockFetch.mock.calls[0];
            expect(url).toBe(`${BASE_URL}/blocks?yes`);
            expect(init!.method).toBe('DELETE');
        });

        it('throws when the server responds non-2xx', async () => {
            mockFetch.mockResolvedValueOnce(fakeResponse({ status: 403 }));

            const client = new KvBlockDeviceHttpClient(BASE_URL);
            await expect(client.format()).rejects.toThrow(/status 403/);
        });
    });
});
