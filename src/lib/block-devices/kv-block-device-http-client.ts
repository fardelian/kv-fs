import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode';
import { KvEncryption } from '../encryption';
import { KvError_BD_Overflow } from '../utils/errors';

/** KvBlockDevice which uses a remote HTTP server. */
export class KvBlockDeviceHttpClient extends KvBlockDevice {
    private readonly baseUrl: string;
    private readonly encryption: KvEncryption;

    constructor(
        blockSize: number,
        capacityBytes: number,
        baseUrl: string,
        encryption: KvEncryption,
    ) {
        super(blockSize, capacityBytes);
        this.baseUrl = baseUrl;
        this.encryption = encryption;
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
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await this.request(blockUrl);
        const resBody = await res.json() as { data: { blockData: number[] } };

        const blockData = Uint8Array.from(resBody.data.blockData);
        return this.encryption.decrypt(blockData);
    }

    /** Write using POST /blocks/:blockId */
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
        const encryptedData = this.encryption.encrypt(blockData);

        const blockUrl = this.getBlockUrl(blockId);
        await this.request(blockUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { blockData: Array.from(encryptedData) } }),
        });
    }

    /** Delete using DELETE /blocks/:blockId */
    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockUrl = this.getBlockUrl(blockId);

        await this.request(blockUrl, { method: 'DELETE' });
    }

    /** Check if block exists using HEAD /blocks/:blockId */
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await fetch(blockUrl, { method: 'HEAD' });

        return res.status === 200;
    }

    /** Get next block ID using PUT /blocks */
    public async allocateBlock(): Promise<INodeId> {
        const res = await this.request(`${this.baseUrl}/blocks`, { method: 'PUT' });
        const resBody = await res.json() as { data: { nextBlockId: INodeId } };

        return resBody.data.nextBlockId;
    }
}
