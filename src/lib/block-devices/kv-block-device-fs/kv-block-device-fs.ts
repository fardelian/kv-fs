import * as fs from 'fs/promises';
import * as path from 'path';
import { KvBlockDevice } from '../helpers/kv-block-device';
import { INodeId } from '../../inode';
import { KvError_BD_Overflow } from '../../utils';

/**
 * `KvBlockDevice` backed by the local filesystem: one file per block,
 * named `{blockId}.txt` under the configured base path. Short writes
 * are zero-padded to `blockSize`.
 */
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

    /**
     * Read `[start, end)` directly from the block file via a positioned
     * `fd.read`, so only the requested bytes leave disk. Avoids the
     * default's "read whole block, slice in memory" round trip.
     */
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) return new Uint8Array(0);
        const fd = await fs.open(this.getBlockPath(blockId), 'r');
        try {
            const buffer = new Uint8Array(end - start);
            await fd.read(buffer, 0, buffer.length, start);
            return buffer;
        } finally {
            await fd.close();
        }
    }

    /**
     * Splice `data` into the block file at byte `offset` via a
     * positioned `fd.write`. Surrounding bytes stay on disk untouched —
     * no read-modify-write needed.
     */
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        if (data.length === 0) return;
        if (offset + data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(offset + data.length, this.getBlockSize());
        }
        const fd = await fs.open(this.getBlockPath(blockId), 'r+');
        try {
            await fd.write(data, 0, data.length, offset);
        } finally {
            await fd.close();
        }
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
