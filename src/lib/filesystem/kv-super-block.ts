import { KvBlockDevice } from '../block-devices';
import { INodeId } from '../inode';
import { dataView, KvError_FS_FormatVersion } from '../utils';

/**
 * Versioned on-disk superblock.
 *
 * Layout:
 * ```
 *   [ 0.. 4)  formatVersion    (uint32)
 *   [ 4..12)  capacityBytes    (uint64)
 *   [12..16)  blockSize        (uint32)
 *   [16..20)  totalInodes      (uint32)
 *   [20..24)  rootDirectoryId  (uint32)
 * ```
 *
 * Bumping the version is mandatory whenever any layer below the superblock
 * (inode header, directory entries, encryption framing, etc.) changes
 * shape. Volumes whose stored version doesn't match
 * `SuperBlock.FORMAT_VERSION` are rejected at mount time so we never
 * silently misread an older or newer format.
 */
export class SuperBlock {
    /**
     * Bump on every breaking on-disk layout change. Volumes from prior
     * versions can no longer be mounted by newer code (and vice versa)
     * until a migration is implemented.
     *
     * v1: initial versioned format.
     * v2: 64-bit timestamps and file sizes; capacityBytes widened to uint64.
     * v3: file inodes carry an indirect-block pointer at the end of the
     *     inode block (4 bytes), shrinking the inline direct-block area by
     *     one slot but enabling files larger than what fits in a single
     *     inode's pointer list.
     */
    public static readonly FORMAT_VERSION = 3;

    public static readonly OFFSET_FORMAT_VERSION = 0;
    public static readonly OFFSET_CAPACITY_BYTES = 4;
    public static readonly OFFSET_BLOCK_SIZE = 12;
    public static readonly OFFSET_TOTAL_INODES = 16;
    public static readonly OFFSET_ROOT_DIRECTORY_ID = 20;

    private blockDevice: KvBlockDevice;
    private superBlockId: INodeId;

    public formatVersion = 0;
    public capacityBytes = 0;
    public blockSize = 0;
    public totalInodes = 0;
    public rootDirectoryId: INodeId = 0;

    constructor(blockDevice: KvBlockDevice, superBlockId: INodeId) {
        this.blockDevice = blockDevice;
        this.superBlockId = superBlockId;
    }

    async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.superBlockId);
        const view = dataView(buffer);

        this.formatVersion = view.getUint32(SuperBlock.OFFSET_FORMAT_VERSION);
        if (this.formatVersion !== SuperBlock.FORMAT_VERSION) {
            throw new KvError_FS_FormatVersion(this.formatVersion, SuperBlock.FORMAT_VERSION);
        }

        this.capacityBytes = Number(view.getBigUint64(SuperBlock.OFFSET_CAPACITY_BYTES));
        this.blockSize = view.getUint32(SuperBlock.OFFSET_BLOCK_SIZE);
        this.totalInodes = view.getUint32(SuperBlock.OFFSET_TOTAL_INODES);
        this.rootDirectoryId = view.getUint32(SuperBlock.OFFSET_ROOT_DIRECTORY_ID);
    }

    public static async createSuperBlock(
        id: INodeId,
        blockDevice: KvBlockDevice,
        totalInodes: number,
        rootDirectory: INodeId,
    ): Promise<SuperBlock> {
        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);

        view.setUint32(SuperBlock.OFFSET_FORMAT_VERSION, SuperBlock.FORMAT_VERSION);
        // capacityBytes comes straight off the device — the filesystem
        // doesn't get to override it.
        view.setBigUint64(SuperBlock.OFFSET_CAPACITY_BYTES, BigInt(blockDevice.getCapacityBytes()));
        view.setUint32(SuperBlock.OFFSET_BLOCK_SIZE, blockDevice.getBlockSize());
        view.setUint32(SuperBlock.OFFSET_TOTAL_INODES, totalInodes);
        view.setUint32(SuperBlock.OFFSET_ROOT_DIRECTORY_ID, rootDirectory);

        await blockDevice.writeBlock(id, buffer);

        return new SuperBlock(blockDevice, id);
    }
}
