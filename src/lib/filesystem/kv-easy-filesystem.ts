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

    // File operations

    public createFile(pathName: string): FileINode {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = this.getDirectory(path.join(this.separator));

        if (directory.getEntry(fileName) !== undefined) {
            throw new Error(`File with name "${fileName}" already exists`);
        }

        return this.filesystem.createFile(fileName, directory);
    }

    public getFile(pathName: string): FileINode {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = this.getDirectory(path.join(this.separator));
        return this.filesystem.getFile(fileName, directory);
    }

    public unlink(pathName: string): void {
        const path = pathName.split(this.separator);
        const fileName = path.pop()!;

        const directory = this.getDirectory(path.join(this.separator));
        this.filesystem.unlink(fileName, directory);
    }

    public readFile(pathName: string): Buffer {
        return this.getFile(pathName).read();
    }

    public writeFile(pathName: string, data: Buffer): void {
        this.getFile(pathName).write(data);
    }

    // Directory operations

    public createDirectory(pathName: string, createPath: boolean = false): DirectoryINode {
        const path = pathName.split(this.separator).slice(1);
        const directoryName = path.pop()!;

        let directory = this.filesystem.getRootDirectory();
        for (const name of path) {
            try {
                directory = this.filesystem.getDirectory(name, directory);
            } catch (err) {
                if (!createPath) throw err;
                directory = this.filesystem.createDirectory(name, directory);
            }
        }

        return this.filesystem.createDirectory(directoryName, directory);
    }

    public getDirectory(pathName: string): DirectoryINode {
        const path = pathName.split(this.separator).slice(1);
        const directoryName = path.pop()!;

        let directory = this.filesystem.getRootDirectory();
        if (directoryName === '') {
            return directory;
        }

        for (const name of path) {
            directory = this.filesystem.getDirectory(name, directory);
        }

        return this.filesystem.getDirectory(directoryName, directory);
    }

    public readDirectory(pathName: string): string[] {
        return Array.from(this.getDirectory(pathName).read().keys());
    }
}
