import * as fs from 'fs';
import * as path from 'path';
import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { KvError_BD_Overflow } from '../utils/errors';

/** KvBlockDevice which uses the local file system. */
export class KvBlockDeviceFs extends KvBlockDevice {
    private readonly localFsBasePath: string;

    constructor(
        blockSize: number,
        capacityBytes: number,
        localFsBasePath: string,
    ) {
        super(blockSize, capacityBytes);
        this.localFsBasePath = localFsBasePath;
    }

    private getBlockPath(blockId: INodeId): string {
        return path.join(this.localFsBasePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const blockPath = this.getBlockPath(blockId);

        return fs.readFileSync(blockPath);
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockPath = this.getBlockPath(blockId);

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);

        fs.writeFileSync(blockPath, blockData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return fs.existsSync(this.getBlockPath(blockId));
    }

    public async allocateBlock(): Promise<INodeId> {
        let blockId = 0;
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
