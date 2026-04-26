import { KvINodeFile, KvINodeDirectory } from '../inode';
import { KvFilesystem } from './kv-filesystem';
import { KvError_FS_Exists } from '../utils';

export class KvFilesystemEasy {
    private readonly filesystem: KvFilesystem;
    private readonly separator;

    constructor(
        filesystem: KvFilesystem,
        separator = '/',
    ) {
        this.filesystem = filesystem;
        this.separator = separator;
    }

    // File operations

    public async createFile(pathName: string): Promise<KvINodeFile> {
        const { parent, leaf } = await this.resolveLeaf(pathName);

        if (await parent.hasEntry(leaf)) {
            throw new KvError_FS_Exists(`File "${pathName}" already exists.`);
        }

        return await this.filesystem.createFile(leaf, parent);
    }

    public async getKvFile(pathName: string): Promise<KvINodeFile> {
        const { parent, leaf } = await this.resolveLeaf(pathName);
        return await this.filesystem.getKvFile(leaf, parent);
    }

    public async readFile(pathName: string): Promise<Uint8Array> {
        const file = await this.getKvFile(pathName);
        return await file.read();
    }

    public async writeFile(pathName: string, data: Uint8Array): Promise<void> {
        const file = await this.getKvFile(pathName);
        await file.truncate();
        await file.write(data);
    }

    // Directory operations

    public async createDirectory(pathName: string, createPath = false): Promise<KvINodeDirectory> {
        const components = this.splitPath(pathName);
        const leaf = components.pop();
        if (leaf === undefined) {
            throw new KvError_FS_Exists(`Cannot create root directory "${pathName}" — it always exists.`);
        }

        let directory = await this.filesystem.getRootDirectory();
        for (const name of components) {
            try {
                directory = await this.filesystem.getDirectory(name, directory);
            } catch (err) {
                if (!createPath) throw err;
                directory = await this.filesystem.createDirectory(name, directory);
            }
        }

        if (await directory.hasEntry(leaf)) {
            throw new KvError_FS_Exists(`Directory entry "${pathName}" already exists.`);
        }

        return await this.filesystem.createDirectory(leaf, directory);
    }

    public async getDirectory(pathName: string): Promise<KvINodeDirectory> {
        const components = this.splitPath(pathName);

        let directory = await this.filesystem.getRootDirectory();
        for (const name of components) {
            directory = await this.filesystem.getDirectory(name, directory);
        }

        return directory;
    }

    public async readDirectory(pathName: string): Promise<string[]> {
        const directory = await this.getDirectory(pathName);
        const directoryEntries = await directory.read();

        return Array.from(directoryEntries.keys());
    }

    // Common operations

    public async unlink(pathName: string): Promise<void> {
        const { parent, leaf } = await this.resolveLeaf(pathName);
        await this.filesystem.unlink(leaf, parent);
    }

    /**
     * Split an absolute path into its non-empty components, dropping the
     * leading separator and any empty segments produced by leading,
     * trailing, or duplicated separators. The root path "/" yields `[]`.
     */
    private splitPath(pathName: string): string[] {
        return pathName.split(this.separator).filter((segment) => segment !== '');
    }

    /**
     * Resolve `pathName` to a `(parent directory, leaf name)` pair, where
     * the leaf is the final path component and the parent is the directory
     * that should contain it. Throws if `pathName` has no leaf (i.e. it is
     * the root path).
     */
    private async resolveLeaf(pathName: string): Promise<{ parent: KvINodeDirectory; leaf: string }> {
        const components = this.splitPath(pathName);
        const leaf = components.pop();
        if (leaf === undefined) {
            throw new KvError_FS_Exists(`Path "${pathName}" has no leaf component.`);
        }

        let parent = await this.filesystem.getRootDirectory();
        for (const name of components) {
            parent = await this.filesystem.getDirectory(name, parent);
        }

        return { parent, leaf };
    }
}
