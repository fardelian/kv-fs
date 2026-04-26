import { KvBlockDevice } from '../helpers/kv-block-device';
import { INodeId } from '../../inode';
import { KvError_BD_Overflow } from '../../utils';
import { KvEncryption } from '../../encryption';

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

        super(exposedBlockSize, blockDevice.getCapacityBlocks() * exposedBlockSize);

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

    /**
     * Encryption hides the per-byte structure underneath, so a partial
     * read can't be served from a partial fetch — we must decrypt the
     * whole block and slice in plaintext. Same total work as the base
     * default; overridden here only to make the dependency on full-block
     * decryption explicit.
     */
    public async readBlockPartial(blockId: INodeId, start: number, end: number): Promise<Uint8Array> {
        if (end <= start) return new Uint8Array(0);
        const plaintext = await this.readBlock(blockId);
        return plaintext.slice(start, end);
    }

    /**
     * Read-modify-write the whole plaintext block: decrypt the existing
     * one, splice `data` in at `offset`, re-encrypt, write it back. A
     * partial-write at this layer always touches the entire underlying
     * encrypted block — encryption schemes here aren't byte-addressable.
     */
    public async writeBlockPartial(blockId: INodeId, offset: number, data: Uint8Array): Promise<void> {
        if (data.length === 0) return;
        if (offset + data.length > this.getBlockSize()) {
            throw new KvError_BD_Overflow(offset + data.length, this.getBlockSize());
        }
        const plaintext = await this.readBlock(blockId);
        const next = new Uint8Array(this.getBlockSize());
        next.set(plaintext);
        next.set(data, offset);
        await this.writeBlock(blockId, next);
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

    public async getHighestBlockId(): Promise<INodeId> {
        return await this.blockDevice.getHighestBlockId();
    }

    public async format(): Promise<void> {
        await this.blockDevice.format();
    }
}
