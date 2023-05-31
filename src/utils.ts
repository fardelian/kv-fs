import { EasyFilesystem } from './lib/kv-easy-filesystem';

type DA = Record<string, DA[] | undefined>;

export const tree = (easyFilesystem: EasyFilesystem, startDirectory: string): DA => {
    const directory = easyFilesystem.getDirectory(startDirectory);

    directory.read().forEach((entry) => {
        // if (entry.type === 'directory') {
        //     tree(easyFilesystem, `${startDirectory}/${entry.name}`);
        // }
    });

    return {};
};
