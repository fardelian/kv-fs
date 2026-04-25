import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { KvError_BD_Overflow } from '../utils/errors';
import { KvEncryption } from '../encryption';

/** Wrap a KvBlockDevice with encryption. Also validates and ensures block size. */
export class KvEncryptedBlockDevice extends KvBlockDevice {
    private readonly blockDevice: KvBlockDevice;
    private readonly encryption: KvEncryption;

    constructor(
        blockDevice: KvBlockDevice,
        encryption: KvEncryption,
    ) {
        super(blockDevice.getBlockSize(), blockDevice.getMaxBlockId() * blockDevice.getBlockSize());

        this.blockDevice = blockDevice;
        this.encryption = encryption;
    }

    public getBlockSize(): number {
        return this.blockDevice.getBlockSize();
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const encryptedData = await this.blockDevice.readBlock(blockId);

        return await this.encryption.decrypt(encryptedData);
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
        const encryptedData = await this.encryption.encrypt(blockData);

        await this.blockDevice.writeBlock(blockId, encryptedData);
    }

    public async freeBlock(blockId: INodeId): Promise<void> {
        await this.blockDevice.freeBlock(blockId);
    }

    public async existsBlock(blockId: INodeId): Promise<boolean> {
        return await this.blockDevice.existsBlock(blockId);
    }

    public async allocateBlock(): Promise<INodeId> {
        return await this.blockDevice.allocateBlock();
    }
}
