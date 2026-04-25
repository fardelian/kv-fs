import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode/kv-inode';
import { Init } from '../utils/init';
import { KvError_BD_Overflow } from '../utils/errors';
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

    @Init
    public async readBlock(blockId: INodeId): Promise<Buffer> {
        const encryptedData = await this.blockDevice.readBlock(blockId);

        return this.encryption.decrypt(encryptedData);
    }

    @Init
    public async writeBlock(blockId: INodeId, data: Buffer): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = Buffer.alloc(this.getBlockSize());
        data.copy(blockData);
        const encryptedData = this.encryption.encrypt(blockData);

        return this.blockDevice.writeBlock(blockId, encryptedData);
    }

    @Init
    public async freeBlock(blockId: INodeId): Promise<void> {
        return this.blockDevice.freeBlock(blockId);
    }

    @Init
    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return this.blockDevice.existsBlock(blockId);
    }

    @Init
    public async getNextINodeId(): Promise<INodeId> {
        return this.blockDevice.getNextINodeId();
    }
}
