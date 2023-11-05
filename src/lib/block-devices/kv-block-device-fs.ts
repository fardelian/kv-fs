import * as fs from 'fs';
import * as path from 'path';
import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { KvError_BD_Overflow } from '../types';

/** KvBlockDevice which uses the local file system. */
export class KvBlockDeviceFs extends KvBlockDevice {
    private readonly localFsBasePath: string;

    constructor(
        blockSize: number,
        localFsBasePath: string,
    ) {
        super(blockSize);
        this.localFsBasePath = localFsBasePath;
    }

    public async init(): Promise<this> {
        await super.init();

        return this;
    }

    private getBlockPath(blockId: INodeId): string {
        this.ensureInit();

        return path.join(this.localFsBasePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.ensureInit();

        const blockPath = this.getBlockPath(blockId);

        return fs.readFileSync(blockPath);
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.ensureInit();

        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockPath = this.getBlockPath(blockId);

        const blockData = Buffer.alloc(this.getBlockSize());
        data.copy(blockData);

        fs.writeFileSync(blockPath, blockData);
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
