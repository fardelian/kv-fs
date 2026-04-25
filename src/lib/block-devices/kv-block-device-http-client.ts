import { KvBlockDevice, KvBlockDeviceMetadata } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { Init, KvError_BD_Overflow } from '../utils';

/**
 * KvBlockDevice that delegates every operation to a remote
 * `KvBlockDeviceHttpRouter` over HTTP. Pure transport — no encryption
 * is performed here. If you want encryption on the wire, wrap the
 * client with `KvEncryptedBlockDevice`.
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
        this.capacityBlocks = body.data.capacityBlocks;
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

    /** Read using GET /blocks/:blockId */
    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await this.request(blockUrl);
        const resBody = await res.json() as { data: { blockData: number[] } };

        return Uint8Array.from(resBody.data.blockData);
    }

    /** Write using PUT /blocks/:blockId */
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { blockData: Array.from(blockData) } }),
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
     * Wipe every block on the remote device. Maps to DELETE /blocks on
     * the server, with the `?yes` deliberate-action gate the server
     * requires. Use with care — this is a destructive operation.
     */
    public async format(): Promise<void> {
        await this.request(`${this.baseUrl}/blocks?yes`, { method: 'DELETE' });
    }
}
