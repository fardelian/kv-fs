import * as fs from 'fs';
import * as path from 'path';
import { BlockDeviceEncryption } from './kv-encryption';
import { KvBlockDevice } from './types';

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

    private getBlockPath(blockId: number): string {
        return path.join(this.basePath, blockId.toString());
    }

    public readBlock(blockId: number): Buffer {
        const blockPath = this.getBlockPath(blockId);

        const rawData = fs.readFileSync(blockPath);
        return this.encryption
            ? this.encryption.decrypt(rawData)
            : rawData;
    }

    public writeBlock(blockId: number, data: Buffer): void {
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

    public freeBlock(blockId: number): void {
        const blockPath = this.getBlockPath(blockId);
        fs.unlinkSync(blockPath);
    }

    public existsBlock(blockId: number): boolean {
        return fs.existsSync(this.getBlockPath(blockId));
    }

    public getNextINodeId(): number {
        let blockId = 0;
        while (this.existsBlock(blockId)) blockId++;
        return blockId;
    }
}
