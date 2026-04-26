import { KvBatchOp, KvBatchResult, KvBlockDevice, KvBlockDeviceMetadata } from '../helpers/kv-block-device';
import { WireBatchOp, WireBatchResult } from '../kv-block-device-common/kv-block-device-common';
import { INodeId } from '../../inode';
import { Init, KvError_BD_Overflow } from '../../utils';
import { hexDecode, hexEncode } from './helpers';

/**
 * KvBlockDevice that delegates every operation to a remote
 * `KvBlockDeviceHttpRouter` over HTTP. Pure transport — no encryption
 * is performed here. If you want encryption on the wire, wrap the
 * client with `KvEncryptedBlockDevice`.
 *
 * Block bodies cross the wire as raw bytes
 * (`Content-Type: application/octet-stream`). Metadata responses (block
 * size / capacity / allocation IDs / errors) are JSON.
 *
 * The block size and capacity are read from the server on `init()`, so
 * the server's block device is the source of truth for layout. Wrap
 * after `init()` resolves; otherwise `getBlockSize()` returns 0 and any
 * downstream wrapper will compute the wrong exposed size.
 */
export class KvBlockDeviceHttpClient extends KvBlockDevice {
    private readonly baseUrl: string;

    constructor(baseUrl: string) {
        // Placeholders; the real values come from the server in init().
        super(0, 0);
        this.baseUrl = baseUrl;
    }

    /** Fetch the server's metadata and configure this device to match. */
    async init(): Promise<void> {
        const res = await this.request(`${this.baseUrl}/blocks`);
        const body = await res.json() as { data: KvBlockDeviceMetadata };
        this.blockSize = body.data.blockSize;
        this.capacityBytes = body.data.capacityBytes;
    }

    protected getBlockUrl(blockId: INodeId): string {
        return `${this.baseUrl}/blocks/${blockId}`;
    }

    private async request(url: string, init?: RequestInit): Promise<Response> {
        const res = await fetch(url, init);
        if (!res.ok) {
            throw new Error(`Request to ${url} failed with status ${res.status}`);
        }
        return res;
    }

    /** Read using GET /blocks/:blockId. Returns raw bytes verbatim. */
    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await this.request(blockUrl);
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
    }

    /**
     * Read a sub-range `[start, end)` from `blockId`. Maps to
     * `GET /blocks/:blockId?start=X&end=Y`; the server slices server-side
     * so only the requested bytes cross the wire.
     */
    @Init
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) {
            return new Uint8Array(0);
        }
        const url = `${this.getBlockUrl(blockId)}?start=${start}&end=${end}`;
        const res = await this.request(url);
        const buffer = await res.arrayBuffer();
        return new Uint8Array(buffer);
    }

    /** Write using PUT /blocks/:blockId. Body is raw bytes, padded to blockSize. */
    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);

        const blockUrl = this.getBlockUrl(blockId);
        await this.request(blockUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            // `body` accepts BodyInit; Uint8Array is one of its valid forms.
            body: blockData,
        });
    }

    /**
     * Splice `data` into `blockId` starting at `offset`. Maps to
     * `PUT /blocks/:blockId?offset=X` with `data` as the raw body; the
     * server preserves the bytes outside `[offset, offset+data.length)`.
     */
    @Init
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        if (data.length === 0) return;
        if (offset + data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(offset + data.length, this.getBlockSize());
        }

        // Copy into a fresh Uint8Array<ArrayBuffer> so the BodyInit
        // signature accepts it (the caller's Uint8Array may be backed by
        // an ArrayBufferLike, which fetch's BodyInit refuses).
        const body = new Uint8Array(data);
        const url = `${this.getBlockUrl(blockId)}?offset=${offset}`;
        await this.request(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body,
        });
    }

    /** Delete using DELETE /blocks/:blockId */
    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockUrl = this.getBlockUrl(blockId);

        await this.request(blockUrl, { method: 'DELETE' });
    }

    /** Check if block exists using HEAD /blocks/:blockId */
    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await fetch(blockUrl, { method: 'HEAD' });

        return res.status === 200;
    }

    /** Allocate a new block ID using POST /blocks (no body). */
    @Init
    public async allocateBlock(): Promise<INodeId> {
        const res = await this.request(`${this.baseUrl}/blocks`, { method: 'POST' });
        const resBody = await res.json() as { data: { blockId: INodeId } };

        return resBody.data.blockId;
    }

    /**
     * Read the highest currently-allocated block ID from the server's
     * metadata. Live — re-fetches each call so callers see fresh state;
     * never cached. Returns `-1` if the server reports no blocks.
     */
    @Init
    public async getHighestBlockId(): Promise<INodeId> {
        const res = await this.request(`${this.baseUrl}/blocks`);
        const body = await res.json() as { data: KvBlockDeviceMetadata };
        return body.data.highestBlockId;
    }

    /**
     * Send a list of ops to the server's `/blocks/batch` endpoint in
     * one round-trip. Overrides the abstract default (sequential
     * dispatch) so that N ops cost 1 HTTP request instead of N.
     */
    @Init
    public async batch(ops: KvBatchOp[]): Promise<KvBatchResult[]> {
        const wireOps: WireBatchOp[] = ops.map((o): WireBatchOp => {
            switch (o.op) {
                case 'read':
                    return { op: 'read', blockId: o.blockId };
                case 'write':
                    return { op: 'write', blockId: o.blockId, data: hexEncode(o.data) };
                case 'free':
                    return { op: 'free', blockId: o.blockId };
                case 'alloc':
                    return { op: 'alloc' };
                case 'partial-read':
                    return { op: 'partial-read', blockId: o.blockId, start: o.start, end: o.end };
                case 'partial-write':
                    return { op: 'partial-write', blockId: o.blockId, offset: o.offset, data: hexEncode(o.data) };
            }
        });

        const res = await this.request(`${this.baseUrl}/blocks/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ops: wireOps }),
        });
        const body = await res.json() as { results: WireBatchResult[] };

        return body.results.map((r): KvBatchResult => {
            if (!r.ok) {
                return { ok: false, error: r.error ?? 'unknown error' };
            }
            const result: { ok: true; data?: Uint8Array; blockId?: INodeId } = { ok: true };
            if (r.data !== undefined) result.data = hexDecode(r.data);
            if (r.blockId !== undefined) result.blockId = r.blockId;
            return result;
        });
    }

    /**
     * Wipe every block on the remote device. Maps to DELETE /blocks on
     * the server, with the `?confirm=yes` deliberate-action gate the
     * server requires. Use with care — this is a destructive operation.
     */
    public async format(): Promise<void> {
        await this.request(`${this.baseUrl}/blocks?confirm=yes`, { method: 'DELETE' });
    }
}
