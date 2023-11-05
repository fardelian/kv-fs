import * as fs from 'fs';
import * as path from 'path';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { KvError_BD_Overflow } from '../types';
import { KvEncryption } from '../encryption/types';

export class KvBlockDeviceFs extends KvBlockDevice {
    private readonly localBasePath: string;
    private readonly encryption: KvEncryption;

    constructor(
        blockSize: number,
        localFsPath: string,
        encryption: KvEncryption,
    ) {
        super(blockSize);
        this.localBasePath = localFsPath;
        this.encryption = encryption;
    }

    public async init(): Promise<this> {
        await super.init();

        return this;
    }

    private getBlockPath(blockId: INodeId): string {
        this.ensureInit();

        return path.join(this.localBasePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.ensureInit();

        const blockPath = this.getBlockPath(blockId);

        const encryptedData = fs.readFileSync(blockPath);
        return this.encryption.decrypt(encryptedData);
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.ensureInit();

        if (data.length > this.blockSize) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.blockSize}" bytes.`);
        }

        const blockPath = this.getBlockPath(blockId);

        const blockData = Buffer.alloc(this.blockSize);
        data.copy(blockData);
        const encryptedData = this.encryption.encrypt(blockData);

        fs.writeFileSync(blockPath, encryptedData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.ensureInit();

        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        this.ensureInit();

        return fs.existsSync(this.getBlockPath(blockId));
    }

    public async getNextINodeId(): Promise<INodeId> {
        this.ensureInit();

        let blockId = 0;
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
