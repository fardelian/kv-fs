import { KvEasyFilesystem } from './lib/filesystem/kv-easy-filesystem';

type DA = Record<string, DA[] | undefined>;

export const tree = (easyFilesystem: KvEasyFilesystem, startDirectory: string): DA => {
    // const directory = easyFilesystem.getDirectory(startDirectory);
    //
    // directory.read().forEach((entry) => {
    //     // if (entry.type === 'directory') {
    //     //     tree(easyFilesystem, `${startDirectory}/${entry.name}`);
    //     // }
    // });

    return {};
};
