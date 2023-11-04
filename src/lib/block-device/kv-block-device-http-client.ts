import * as fs from 'fs';
import * as path from 'path';
import { KvEncryptionKey } from '../encryption/kv-encryption-key';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';

export class KvBlockDeviceHttpClient implements KvBlockDevice {
    public readonly blockSize: number;

    private readonly baseUrl: string;
    private readonly encryption: KvEncryptionKey;

    constructor(
        baseUrl: string,
        blockSize: number,
        encryption: KvEncryptionKey,
    ) {
        this.baseUrl = baseUrl;
        this.blockSize = blockSize;
        this.encryption = encryption;
    }

    private getBlockPath(blockId: INodeId): string {
        return path.join(this.baseUrl, blockId.toString());
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        const blockPath = this.getBlockPath(blockId);

        const rawData = fs.readFileSync(blockPath);
        return this.encryption
            ? this.encryption.decrypt(rawData)
            : rawData;
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        if (data.length > this.blockSize) {
            throw new Error(`Data size "${data.length}" is larger than block size "${this.blockSize}"`);
        }

        const blockPath = this.getBlockPath(blockId);

        const rawData = this.encryption
            ? this.encryption.encrypt(data)
            : data;
        const blockData = Buffer.alloc(this.blockSize);
        rawData.copy(blockData);
        fs.writeFileSync(blockPath, blockData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return fs.existsSync(this.getBlockPath(blockId));
    }

    public async getNextINodeId(): Promise<INodeId> {
        let blockId = 0;
        while (this.existsBlock(blockId)) blockId++;
        return blockId;
    }
}
