import { KvBlockDevice } from '../../block-devices';
import { dataView } from '../../utils';

export type INodeId = number;

/**
 * Common inode header for files and directories.
 *
 * On-disk layout (uint64 ms-since-epoch):
 * ```
 *   [0..8)   creationTime
 *   [8..16)  modificationTime
 * ```
 *
 * Subclasses lay their own fields after offset 16.
 */
export abstract class INode<DataType> {
    public static readonly OFFSET_CREATION_TIME = 0;
    public static readonly OFFSET_MODIFICATION_TIME = 8;
    public static readonly HEADER_SIZE = 16;

    public readonly id: INodeId;
    public blockDevice: KvBlockDevice;

    public creationTime: Date = new Date(0);
    public modificationTime: Date = new Date(0);

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        this.blockDevice = blockDevice;
        this.id = id;
    }

    async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        const creationTimeMs = Number(view.getBigUint64(INode.OFFSET_CREATION_TIME));
        const modificationTimeMs = Number(view.getBigUint64(INode.OFFSET_MODIFICATION_TIME));

        this.creationTime = new Date(creationTimeMs);
        this.modificationTime = new Date(modificationTimeMs);
    }

    protected abstract read(): Promise<DataType>;

    protected abstract write(data: DataType): Promise<void>;
}
