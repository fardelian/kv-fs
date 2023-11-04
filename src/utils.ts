import { KvFilesystemEasy } from './lib/filesystem/kv-filesystem-easy';

type DA = Record<string, DA[] | undefined>;

export const tree = (easyFilesystem: KvFilesystemEasy, startDirectory: string): DA => {
    // const directory = easyFilesystem.getDirectory(startDirectory);
    //
    // directory.read().forEach((entry) => {
    //     // if (entry.type === 'directory') {
    //     //     tree(easyFilesystem, `${startDirectory}/${entry.name}`);
    //     // }
    // });

    return {};
};
