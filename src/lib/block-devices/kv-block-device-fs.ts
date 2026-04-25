import * as fs from 'fs/promises';
import * as path from 'path';
import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { KvError_BD_Overflow } from '../utils';

/** KvBlockDevice which uses the local file system. One file per block. */
export class KvBlockDeviceFs extends KvBlockDevice {
    private readonly localFsBasePath: string;

    constructor(
        blockSize: number,
        capacityBlocks: number,
        localFsBasePath: string,
    ) {
        super(blockSize, capacityBlocks);
        this.localFsBasePath = localFsBasePath;
    }

    private getBlockPath(blockId: INodeId): string {
        return path.join(this.localFsBasePath, blockId.toString()) + '.txt';
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        return await fs.readFile(this.getBlockPath(blockId));
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);

        await fs.writeFile(this.getBlockPath(blockId), blockData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        await fs.unlink(this.getBlockPath(blockId));
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        try {
            await fs.access(this.getBlockPath(blockId));
            return true;
        } catch {
            return false;
        }
    }

    public async allocateBlock(): Promise<INodeId> {
        let blockId = 0;
        while (await this.existsBlock(blockId)) {
            blockId++;
        }
        return blockId;
    }

    public async getHighestBlockId(): Promise<INodeId> {
        return (await fs.readdir(this.localFsBasePath))
            .filter((fileName) => /^\d+\.txt$/.exec(fileName))
            .map((fileName) => Number(fileName.split('.')[0]))
            .reduce((prev, curr) => Math.max(prev, curr), -1);
    }

    public async format(): Promise<void> {
        const blockFiles = (await fs.readdir(this.localFsBasePath))
            .filter((fileName) => /^\d+\.txt$/.exec(fileName));
        await Promise.all(
            blockFiles.map((fileName) => fs.unlink(path.join(this.localFsBasePath, fileName))),
        );
    }
}
