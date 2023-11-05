import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import axios from 'axios';
import { KvEncryption } from '../encryption/types';

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

    private getBlockUrl(blockId: INodeId): string {
        return `${this.baseUrl}/blocks/${blockId}`;
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await axios.get(blockUrl);
        const resData = res.data.data;

        const blockData = Buffer.from(resData.blockData);
        return this.encryption.decrypt(blockData);
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        if (data.length > this.blockSize) {
            throw new Error(`Data size "${data.length}" is larger than block size "${this.blockSize}"`);
        }

        const blockData = Buffer.alloc(this.blockSize);
        data.copy(blockData);
        const encryptedData = this.encryption.encrypt(blockData);

        const blockUrl = this.getBlockUrl(blockId);
        await axios.post(blockUrl, { data: { blockData: Array.from(encryptedData) } });
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockUrl = this.getBlockUrl(blockId);

        await axios.delete(blockUrl);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        const blockUrl = this.getBlockUrl(blockId);
        const res = await axios.head(blockUrl, { validateStatus: () => true });

        return res.status === 200;
    }

    public async getNextINodeId(): Promise<INodeId> {
        const res = await axios.put(`${this.baseUrl}/blocks`);

        return res.data.data.nextBlockId;
    }
}
