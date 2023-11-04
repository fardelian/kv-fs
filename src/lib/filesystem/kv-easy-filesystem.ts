import { FileINode } from '../inode/kv-file-inode';
import { KvFilesystem } from './kv-filesystem';
import { DirectoryINode } from '../inode/kv-directory-inode';

export class KvEasyFilesystem {
    private readonly filesystem: KvFilesystem;
    private readonly separator;

    constructor(
        filesystem: KvFilesystem,
        separator: string = '/',
    ) {
        this.filesystem = filesystem;
        this.separator = separator;
    }

    public async init(): Promise<this> {
        return this;
    }

    // File operations

    public async createFile(pathName: string): Promise<FileINode> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));

        if (await directory.getEntry(fileName) !== undefined) {
            throw new Error(`File with name "${fileName}" already exists`);
        }

        return await this.filesystem.createFile(fileName, directory);
    }

    public async getFile(pathName: string): Promise<FileINode> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));
        return await this.filesystem.getFile(fileName, directory);
    }

    public async unlink(pathName: string): Promise<void> {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = await this.getDirectory(path.join(this.separator));
        await this.filesystem.unlink(fileName, directory);
    }

    public async readFile(pathName: string): Promise<Buffer> {
        const file = await this.getFile(pathName);
        return await file.read();
    }

    public async writeFile(pathName: string, data: Buffer): Promise<void> {
        const file = await this.getFile(pathName);
        await file.write(data);
    }

    // Directory operations

    public async createDirectory(pathName: string, createPath: boolean = false): Promise<DirectoryINode> {
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

    public async getDirectory(pathName: string): Promise<DirectoryINode> {
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

    public async readDirectory(pathName: string): Promise<string[]> {
        const directory = await this.getDirectory(pathName);
        const directoryEntries = await directory.read();

        return Array.from(directoryEntries.keys());
    }
}
