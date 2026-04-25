import * as fs from 'fs';
import * as path from 'path';
import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode';
import { Init } from '../utils/init';
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

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const blockPath = this.getBlockPath(blockId);

        return fs.readFileSync(blockPath);
    }

    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockPath = this.getBlockPath(blockId);

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);

        fs.writeFileSync(blockPath, blockData);
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return fs.existsSync(this.getBlockPath(blockId));
    }

    @Init
    public async allocateBlock(): Promise<INodeId> {
        let blockId = 0;
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }
}
