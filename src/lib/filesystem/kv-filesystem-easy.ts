import { KvINodeFile, KvINodeDirectory } from '../inode';
import { KvFilesystem } from './kv-filesystem';
import { Init } from '../utils/init';
import { KvError_FS_Exists } from '../utils/errors';

export class KvFilesystemEasy {
    private readonly filesystem: KvFilesystem;
    private readonly separator;

    constructor(
        filesystem: KvFilesystem,
        separator: string = '/',
    ) {
        this.filesystem = filesystem;
        this.separator = separator;
    }

    // File operations

    @Init
    public async createFile(pathName: string): Promise<KvINodeFile> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));

        if (await directory.getEntry(fileName) !== undefined) {
            throw new KvError_FS_Exists(`File "${pathName}" already exists.`);
        }

        return await this.filesystem.createFile(fileName, directory);
    }

    @Init
    public async getFile(pathName: string): Promise<KvINodeFile> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));
        return await this.filesystem.getFile(fileName, directory);
    }

    @Init
    public async readFile(pathName: string): Promise<Uint8Array> {
        const file = await this.getFile(pathName);
        return await file.read();
    }

    @Init
    public async writeFile(pathName: string, data: Uint8Array): Promise<void> {
        const file = await this.getFile(pathName);
        await file.write(data);
    }

    // Directory operations

    @Init
    public async createDirectory(pathName: string, createPath: boolean = false): Promise<KvINodeDirectory> {
        const path = pathName.split(this.separator).slice(1);
        const directoryName = path.pop()!;

        let directory = await this.filesystem.getRootDirectory();
        for (const name of path) {
            try {
                directory = await this.filesystem.getDirectory(name, directory);
            } catch (err) {
                if (!createPath) throw err;
                directory = await this.filesystem.createDirectory(name, directory);
            }
        }

        return await this.filesystem.createDirectory(directoryName, directory);
    }

    @Init
    public async getDirectory(pathName: string): Promise<KvINodeDirectory> {
        const path = pathName.split(this.separator).slice(1);
        const directoryName = path.pop()!;

        let directory = await this.filesystem.getRootDirectory();
        if (directoryName === '') {
            return directory;
        }

        for (const name of path) {
            directory = await this.filesystem.getDirectory(name, directory);
        }

        return await this.filesystem.getDirectory(directoryName, directory);
    }

    @Init
    public async readDirectory(pathName: string): Promise<string[]> {
        const directory = await this.getDirectory(pathName);
        const directoryEntries = await directory.read();

        return Array.from(directoryEntries.keys());
    }

    // Common operations

    @Init
    public async unlink(pathName: string): Promise<void> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));
        await this.filesystem.unlink(fileName, directory);
    }
}
