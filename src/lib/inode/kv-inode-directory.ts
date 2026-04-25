import { INode, INodeId } from './helpers/kv-inode';
import { KvBlockDevice } from '../block-devices';
import { Init, dataView, utf8Decode, utf8Encode, KvError_INode_NameOverflow } from '../utils';

type DirectoryEntriesList = Map<string, INodeId>;

export class KvINodeDirectory extends INode<DirectoryEntriesList> {
    public static readonly MAX_NAME_LENGTH = 255;
    public static readonly OFFSET_NUM_ENTRIES = 16;
    public static readonly OFFSET_ENTRIES_PREFIX = 20;

    private entries: DirectoryEntriesList = new Map();

    protected async init(): Promise<void> {
        await super.init();

        const buffer = await this.blockDevice.readBlock(this.id);
        const view = dataView(buffer);
        const numEntries = view.getInt32(KvINodeDirectory.OFFSET_NUM_ENTRIES, false);

        for (let i = 0; i < numEntries; i++) {
            const nameOffset = KvINodeDirectory.OFFSET_ENTRIES_PREFIX + i * 268 + 1;
            const nameLength = view.getInt8(KvINodeDirectory.OFFSET_ENTRIES_PREFIX + i * 268);

            const name = utf8Decode(buffer, nameOffset, nameOffset + nameLength);
            const iNodeId = view.getInt32(nameOffset + KvINodeDirectory.MAX_NAME_LENGTH, false);

            this.entries.set(name, iNodeId);
        }
    }

    @Init
    public async read(): Promise<DirectoryEntriesList> {
        return new Map(this.entries);
    }

    @Init
    public async write(newEntries: DirectoryEntriesList): Promise<void> {
        this.entries = newEntries;
        this.modificationTime = new Date();

        const buffer = new Uint8Array(this.blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(0, BigInt(this.creationTime.getTime()), false);
        view.setBigUint64(8, BigInt(this.modificationTime.getTime()), false);
        view.setInt32(16, this.entries.size, false);

        let i = 0;
        for (const [name, iNodeId] of this.entries) {
            const nameBytes = utf8Encode(name);
            if (nameBytes.length > KvINodeDirectory.MAX_NAME_LENGTH) {
                throw new KvError_INode_NameOverflow(`INode name "${name}" length "${name.length}" exceeds maximum length "${KvINodeDirectory.MAX_NAME_LENGTH}".`);
            }
            view.setInt8(20 + i * 268, nameBytes.length);
            buffer.set(nameBytes, 20 + i * 268 + 1);
            view.setInt32(20 + i * 268 + 256, iNodeId, false);
            i++;
        }

        await this.blockDevice.writeBlock(this.id, buffer);
    }

    @Init
    public async addEntry(name: string, iNodeId: INodeId): Promise<void> {
        this.entries.set(name, iNodeId);
        await this.write(this.entries);
    }

    @Init
    public async removeEntry(name: string): Promise<void> {
        this.entries.delete(name);
        await this.write(this.entries);
    }

    @Init
    public async getEntry(name: string): Promise<INodeId | undefined> {
        return this.entries.get(name);
    }

    public static async createEmptyDirectory(blockDevice: KvBlockDevice, blockId: INodeId): Promise<KvINodeDirectory> {
        const buffer = new Uint8Array(blockDevice.getBlockSize());
        const view = dataView(buffer);
        view.setBigUint64(0, BigInt(Date.now()), false);
        view.setBigUint64(8, BigInt(Date.now()), false);
        view.setInt32(16, 0, false);

        await blockDevice.writeBlock(blockId, buffer);

        const directory = new KvINodeDirectory(blockDevice, blockId);
        await directory.write(new Map());

        return directory;
    }
}
