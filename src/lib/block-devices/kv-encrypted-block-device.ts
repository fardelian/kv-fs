import { KvBlockDevice } from './kv-block-device.base';
import { INodeId } from '../inode';
import { Init } from '../utils/init';
import { KvError_BD_Overflow } from '../utils/errors';
import { KvEncryption } from '../encryption';

/** Wrap a KvBlockDevice with encryption. Also validates and ensures block size.*/
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

    @Init
    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const encryptedData = await this.blockDevice.readBlock(blockId);

        return this.encryption.decrypt(encryptedData);
    }

    @Init
    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(`Data size "${data.length}" bytes exceeds block size "${this.getBlockSize()}" bytes.`);
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
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
    public async allocateBlock(): Promise<INodeId> {
        return this.blockDevice.allocateBlock();
    }
}
