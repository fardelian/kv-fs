import { KvBlockDevice } from './helpers/kv-block-device';
import { INodeId } from '../inode';
import { KvError_BD_Overflow } from '../utils';
import { KvEncryption } from '../encryption';

/**
 * Wrap a KvBlockDevice with encryption. The exposed `blockSize` is the
 * wrapped device's block size minus the encryption scheme's overhead, so
 * a full encrypted block (plaintext + IV/padding/etc.) fits exactly into
 * one underlying block.
 *
 * For length-preserving schemes (ROT13, Caesar, AES-XTS) overhead is 0
 * and the exposed block size equals the wrapped one. For padded schemes
 * (AES-CBC) overhead is non-zero — e.g. 32 bytes for AES-CBC (16-byte
 * IV + one full PKCS#7 padding block).
 */
export class KvEncryptedBlockDevice extends KvBlockDevice {
    private readonly blockDevice: KvBlockDevice;
    private readonly encryption: KvEncryption;

    constructor(
        blockDevice: KvBlockDevice,
        encryption: KvEncryption,
    ) {
        const innerBlockSize = blockDevice.getBlockSize();
        const exposedBlockSize = innerBlockSize - encryption.overheadBytes;
        if (exposedBlockSize <= 0) {
            throw new Error(`Wrapped device's block size (${innerBlockSize}) is too small for encryption overhead (${encryption.overheadBytes}).`);
        }

        super(exposedBlockSize, blockDevice.getMaxBlockId() * exposedBlockSize);

        this.blockDevice = blockDevice;
        this.encryption = encryption;
    }

    public async readBlock(blockId: INodeId): Promise<Uint8Array> {
        const encryptedData = await this.blockDevice.readBlock(blockId);

        return await this.encryption.decrypt(blockId, encryptedData);
    }

    public async writeBlock(blockId: INodeId, data: Uint8Array): Promise<void> {
        if (data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(data.length, this.getBlockSize());
        }

        const blockData = new Uint8Array(this.getBlockSize());
        blockData.set(data);
        const encryptedData = await this.encryption.encrypt(blockId, blockData);

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
