import { KvBlockDevice } from '../../block-devices';
import { dataView } from '../../utils';

export type INodeId = number;

/** Discriminator stored at offset 0 of every inode block. */
export const KV_INODE_KIND_DIRECTORY = 0;
export const KV_INODE_KIND_FILE = 1;

/**
 * Common inode header for files and directories.
 *
 * On-disk layout:
 * ```
 *   [ 0.. 1)   kind  (uint8: 0 = directory, 1 = file)
 *   [ 1.. 8)   reserved (7 bytes, zero-padded)
 *   [ 8..16)   creationTime (uint64 ms-since-epoch)
 *   [16..24)   modificationTime (uint64 ms-since-epoch)
 * ```
 *
 * Subclasses lay their own fields after offset 24. The kind byte is
 * read at init() time and a mismatch (e.g. `KvINodeFile` instantiated
 * over a directory's inode block) throws — that's how the easy-FS
 * layer above can robustly tell file paths from directory paths.
 */
export abstract class INode<DataType> {
    public static readonly OFFSET_KIND = 0;
    public static readonly OFFSET_CREATION_TIME = 8;
    public static readonly OFFSET_MODIFICATION_TIME = 16;
    public static readonly HEADER_SIZE = 24;

    public readonly id: INodeId;
    public blockDevice: KvBlockDevice;

    public creationTime: Date = new Date(0);
    public modificationTime: Date = new Date(0);

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        this.blockDevice = blockDevice;
        this.id = id;
    }

    /** The on-disk discriminator subclasses commit to. */
    public abstract get kind(): number;

    async init(): Promise<void> {
        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);

        const storedKind = view.getUint8(INode.OFFSET_KIND);
        if (storedKind !== this.kind) {
            throw new KvError_INode_KindMismatch(this.id, this.kind, storedKind);
        }

        const creationTimeMs = Number(view.getBigUint64(INode.OFFSET_CREATION_TIME));
        const modificationTimeMs = Number(view.getBigUint64(INode.OFFSET_MODIFICATION_TIME));

        this.creationTime = new Date(creationTimeMs);
        this.modificationTime = new Date(modificationTimeMs);
    }

    protected abstract read(): Promise<DataType>;

    protected abstract write(data: DataType): Promise<void>;
}

/**
 * Thrown when an inode block's stored `kind` byte doesn't match the
 * subclass trying to read it (e.g. `KvINodeFile` opened over what is
 * actually a directory). The easy-FS layer treats this as a not-found
 * for the wrong-kind lookup.
 */
export class KvError_INode_KindMismatch extends Error {
    constructor(
        public readonly blockId: INodeId,
        public readonly expectedKind: number,
        public readonly storedKind: number,
    ) {
        super(`Inode at block "${blockId}" has stored kind ${storedKind}, expected ${expectedKind}.`);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}
