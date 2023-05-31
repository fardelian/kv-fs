import { FileSystemEncryption } from './lib/kv-encryption';
import { BlockDevice } from './lib/kv-block-device';
import { Filesystem } from './lib/kv-filesystem';
import { EasyFilesystem } from './lib/kv-easy-filesystem';

const SUPER_BLOCK_ID = 0;
const ROOT_DIRECTORY_ID = 1;

// const password = FileSystemEncryption.keyFromPassword(
//     'password',
//     'salt',
//     100000,
// );

const blockDevice = new BlockDevice(
    `${__dirname}/../data`,
    1024,
    // new FileSystemEncryption(password),
);

// Create file system

Filesystem.format(blockDevice, 100, 100);

const fileSystem = new Filesystem(blockDevice, SUPER_BLOCK_ID);
const easyFileSystem = new EasyFilesystem(fileSystem, '/');

// Create test files

easyFileSystem.createDirectory('/home/florin', true);

const testWrite1 = '/home/florin/test1.txt';
easyFileSystem.createFile(testWrite1).write( Buffer.from('hello world'));

const testWrite2 = '/home/florin/test2.txt';
easyFileSystem.createFile(testWrite2).write( Buffer.from('and hello again'));

// Read test files

const testRead1 = easyFileSystem.readFile('/home/florin/test1.txt');
const testRead2 = easyFileSystem.readFile('/home/florin/test2.txt');
const testDir = easyFileSystem.getDirectory('/home/florin');

console.log(testRead1.toString());
console.log(testRead2.toString());
console.log(JSON.stringify(
    [...testDir.read()],
));
