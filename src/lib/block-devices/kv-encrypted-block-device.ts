import { KvBlockDevice } from './types';
import { INodeId } from '../inode/kv-inode';
import { KvError_BD_Overflow } from '../types';
import { KvEncryption } from '../encryption/types';

/** Wrap a KvBlockDevice with encryption. Also validates and ensures block size.*/
export class KvEncryptedBlockDevice extends KvBlockDevice {
    private readonly blockDevice: KvBlockDevice;
    private readonly encryption: KvEncryption;

    constructor(
        blockDevice: KvBlockDevice,
        encryption: KvEncryption,
    ) {
        super(blockDevice.getBlockSize());

        this.blockDevice = blockDevice;
        this.encryption = encryption;
    }

    public getBlockSize(): number {
        return this.blockDevice.getBlockSize();
    }

    public async readBlock(blockId: INodeId): Promise<Buffer> {
        this.ensureInit();

        const encryptedData = await this.blockDevice.readBlock(blockId);

        return this.encryption.decrypt(encryptedData);
    }

    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        this.ensureInit();

        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = Buffer.alloc(this.getBlockSize());
        data.copy(blockData);
        const encryptedData = this.encryption.encrypt(blockData);

        return this.blockDevice.writeBlock(blockId, encryptedData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        this.ensureInit();

        return this.blockDevice.freeBlock(blockId);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        this.ensureInit();

        return this.blockDevice.existsBlock(blockId);
    }

    public async getNextINodeId(): Promise<INodeId> {
        this.ensureInit();

        return this.blockDevice.getNextINodeId();
    }
}
