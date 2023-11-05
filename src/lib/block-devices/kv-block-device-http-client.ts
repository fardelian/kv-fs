import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import axios from 'axios';
import { KvEncryption } from '../encryption/types';
import { KvError_BD_Overflow } from '../types';

/** KvBlockDevice which uses a remote HTTP server. */
export class KvBlockDeviceHttpClient extends KvBlockDevice {
    private readonly baseUrl: string;
    private readonly encryption: KvEncryption;

    constructor(
        blockSize: number,
        baseUrl: string,
        encryption: KvEncryption,
    ) {
        super(blockSize);
        this.baseUrl = baseUrl;
        this.encryption = encryption;
    }

    protected getBlockUrl(blockId: INodeId): string {
        return `${this.baseUrl}/blocks/${blockId}`;
    }

    /** Read using GET /blocks/:blockId */
    public async readBlock(blockId: INodeId): Promise<Buffer> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await axios.get(blockUrl);
        const resData = res.data.data;

        const blockData = Buffer.from(resData.blockData);
        return this.encryption.decrypt(blockData);
    }

    /** Write using POST /blocks/:blockId */
    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = Buffer.alloc(this.getBlockSize());
        data.copy(blockData);
        const encryptedData = this.encryption.encrypt(blockData);

        const blockUrl = this.getBlockUrl(blockId);
        await axios.post(blockUrl, { data: { blockData: Array.from(encryptedData) } });
    }

    /** Delete using DELETE /blocks/:blockId */
    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockUrl = this.getBlockUrl(blockId);

        await axios.delete(blockUrl);
    }

    /** Check if block exists using HEAD /blocks/:blockId */
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await axios.head(blockUrl, { validateStatus: () => true });

        return res.status === 200;
    }

    /** Get next block ID using PUT /blocks */
    public async getNextINodeId(): Promise<INodeId> {
        const res = await axios.put(`${this.baseUrl}/blocks`);

        return res.data.data.nextBlockId;
    }
}
