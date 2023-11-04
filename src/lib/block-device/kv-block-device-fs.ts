import * as fs from 'fs';
import * as path from 'path';
import { BlockDeviceEncryption } from './kv-encryption';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';

export class KvBlockDeviceFs implements KvBlockDevice {
    private readonly basePath: string;
    public readonly blockSize: number;
    private readonly encryption?: BlockDeviceEncryption;

    constructor(
        basePath: string,
        blockSize: number,
        encryption?: BlockDeviceEncryption,
    ) {
        this.basePath = basePath;
        this.blockSize = blockSize;
        this.encryption = encryption;
    }

    public async init(): Promise<this> {
        return this;
    }

    private getBlockPath(blockId: INodeId): string {
        return path.join(this.basePath, blockId.toString()) + '.txt';
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

        const rawData = this.encryption ? this.encryption.encrypt(data) : data;
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
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
