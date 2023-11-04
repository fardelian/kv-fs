import { INode, INodeId } from './kv-inode';
import { KvBlockDevice } from '../block-device/types';

type DirectoryEntriesList = Map<string, INodeId>;

export class DirectoryINode extends INode<DirectoryEntriesList> {
    public static readonly MAX_NAME_LENGTH = 255;
    public static readonly OFFSET_NUM_ENTRIES = 16;
    public static readonly OFFSET_ENTRIES_PREFIX = 20;

    private entries: DirectoryEntriesList = new Map();

    constructor(blockDevice: KvBlockDevice, id: INodeId) {
        super(blockDevice, id);
    }

    public async init(): Promise<this> {
        await super.init();

        this.entries = new Map();

        const buffer = await this.blockDevice.readBlock(this.id);
        const numEntries = buffer.readInt32BE(DirectoryINode.OFFSET_NUM_ENTRIES);

        for (let i = 0; i < numEntries; i++) {
            const nameOffset = DirectoryINode.OFFSET_ENTRIES_PREFIX + i * 268 + 1;
            const nameLength = buffer.readInt8(DirectoryINode.OFFSET_ENTRIES_PREFIX + i * 268);

            const name = buffer.toString('utf8', nameOffset, nameOffset + nameLength);
            const inodeId = buffer.readInt32BE(nameOffset + DirectoryINode.MAX_NAME_LENGTH);

            this.entries.set(name, inodeId);
        }

        return this;
    }

    public async read(): Promise<DirectoryEntriesList> {
        return new Map(this.entries);
    }

    public async write(newEntries: DirectoryEntriesList): Promise<void> {
        this.entries = newEntries;
        this.modificationTime = new Date();

        const buffer = Buffer.alloc(this.blockDevice.blockSize);
        buffer.writeBigUInt64BE(BigInt(this.creationTime.getTime()), 0);
        buffer.writeBigUInt64BE(BigInt(this.modificationTime.getTime()), 8);
        buffer.writeInt32BE(this.entries.size, 16);

        let i = 0;
        for (const [name, inodeId] of this.entries) {
            const nameBuffer = Buffer.from(name, 'utf8');
            if (nameBuffer.length > DirectoryINode.MAX_NAME_LENGTH) {
                throw new Error('Name is too long for a directory entry');
            }
            buffer.writeInt8(nameBuffer.length, 20 + i * 268);
            nameBuffer.copy(buffer, 20 + i * 268 + 1);
            buffer.writeInt32BE(inodeId, 20 + i * 268 + 256);
            i++;
        }

        await this.blockDevice.writeBlock(this.id, buffer);
    }

    public async addEntry(name: string, inodeId: INodeId): Promise<void> {
        this.entries.set(name, inodeId);
        await this.write(this.entries);
    }

    public async removeEntry(name: string): Promise<void> {
        this.entries.delete(name);
        await this.write(this.entries);
    }

    public async getEntry(name: string): Promise<INodeId | undefined> {
        return this.entries.get(name);
    }

    public static async createEmptyDirectory(blockDevice: KvBlockDevice, id: INodeId): Promise<DirectoryINode> {
        const buffer = Buffer.alloc(blockDevice.blockSize);
        buffer.writeBigUInt64BE(BigInt(Date.now()), 0);
        buffer.writeBigUInt64BE(BigInt(Date.now()), 8);
        buffer.writeInt32BE(0, 16);

        await blockDevice.writeBlock(id, buffer);

        const directory = new DirectoryINode(blockDevice, id);
        await directory.init();
        await directory.write(new Map());

        return directory;
    }
}
