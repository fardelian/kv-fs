import { INode } from './kv-inode';
import { BlockDevice } from './kv-block-device';

export type INodeType = 'directory' | 'file';
export const INodeTypeMap: INodeType[] = ['directory', 'file'];

type DirectoryEntry = { id: number, type: number };
type DirectoryEntriesList = Map<string, number>;

export class DirectoryINode extends INode<DirectoryEntriesList> {
    public static readonly MAX_NAME_LENGTH = 255;
    public static readonly OFFSET_NUM_ENTRIES = 16;
    public static readonly OFFSET_SIZE = 20;

    private entries: DirectoryEntriesList;

    constructor(blockDevice: BlockDevice, id: number) {
        super(blockDevice, id);

        this.entries = new Map();

        const buffer = this.blockDevice.readBlock(this.id);
        const numEntries = buffer.readInt32BE(DirectoryINode.OFFSET_NUM_ENTRIES);

        for (let i = 0; i < numEntries; i++) {
            const nameLength = buffer.readInt8(20 + i * 268);
            const name = buffer.toString('utf8', 20 + i * 268 + 1, 20 + i * 268 + 1 + nameLength);
            const inodeId = buffer.readInt32BE(20 + i * 268 + 256);
            this.entries.set(name, inodeId);
        }
    }

    public read(): DirectoryEntriesList {
        return new Map(this.entries);
    }

    public write(newEntries: DirectoryEntriesList): void {
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

        this.blockDevice.writeBlock(this.id, buffer);
    }

    public addEntry(name: string, inodeId: number): void {
        this.entries.set(name, inodeId);
        this.write(this.entries);
    }

    public removeEntry(name: string): void {
        this.entries.delete(name);
        this.write(this.entries);
    }

    public getEntry(name: string): number | undefined {
        return this.entries.get(name);
    }

    public static createEmptyDirectory(blockDevice: BlockDevice, id: number): DirectoryINode {
        const buffer = Buffer.alloc(blockDevice.blockSize);
        buffer.writeBigUInt64BE(BigInt(Date.now()), 0);
        buffer.writeBigUInt64BE(BigInt(Date.now()), 8);
        buffer.writeInt32BE(0, 16);

        blockDevice.writeBlock(id, buffer);

        const directory = new DirectoryINode(blockDevice, id);
        directory.write(new Map());

        return directory;
    }
}
