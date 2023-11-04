import * as fs from 'fs';
import * as path from 'path';
import { KvEncryption } from './kv-encryption';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { Init, KvError_BD_Overflow } from '../types';

export class KvBlockDeviceFs extends Init implements KvBlockDevice {
    private readonly basePath: string;
    public readonly blockSize: number;
    private readonly encryption?: KvEncryption;

    constructor(
        basePath: string,
        blockSize: number,
        encryption?: KvEncryption,
    ) {
        super();
        this.basePath = basePath;
        this.blockSize = blockSize;
        this.encryption = encryption;
    }

    public async init(): Promise<this> {
        await super.init();

        return this;
    }

    private getBlockPath(blockId: INodeId): string {
        this.checkInit();

        return path.join(this.basePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.checkInit();

        const blockPath = this.getBlockPath(blockId);

        const rawData = fs.readFileSync(blockPath);
        return this.encryption
            ? this.encryption.decrypt(rawData)
            : rawData;
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.checkInit();

        if (data.length > this.blockSize) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.blockSize}" bytes.`);
        }

        const blockPath = this.getBlockPath(blockId);

        const rawData = this.encryption ? this.encryption.encrypt(data) : data;
        const blockData = Buffer.alloc(this.blockSize);
        rawData.copy(blockData);
        fs.writeFileSync(blockPath, blockData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.checkInit();

        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        this.checkInit();

        return fs.existsSync(this.getBlockPath(blockId));
    }

    public async getNextINodeId(): Promise<INodeId> {
        this.checkInit();

        let blockId = 0;
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
