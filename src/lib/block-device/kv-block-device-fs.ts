import * as fs from 'fs';
import * as path from 'path';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { Init, KvError_BD_Overflow } from '../types';
import { KvEncryption } from '../encryption/types';

export class KvBlockDeviceFs extends Init implements KvBlockDevice {
    public readonly blockSize: number;

    private readonly localBasePath: string;
    private readonly encryption: KvEncryption;

    constructor(
        localFsPath: string,
        blockSize: number,
        encryption: KvEncryption,
    ) {
        super();
        this.localBasePath = localFsPath;
        this.blockSize = blockSize;
        this.encryption = encryption;
    }

    public async init(): Promise<this> {
        await super.init();

        return this;
    }

    private getBlockPath(blockId: INodeId): string {
        this.checkInit();

        return path.join(this.localBasePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.checkInit();

        const blockPath = this.getBlockPath(blockId);

        const rawData = fs.readFileSync(blockPath);
        return this.encryption.decrypt(rawData);
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.checkInit();

        if (data.length > this.blockSize) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.blockSize}" bytes.`);
        }

        const blockPath = this.getBlockPath(blockId);

        const rawData = this.encryption.encrypt(data);
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
