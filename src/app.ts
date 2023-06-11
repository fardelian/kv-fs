import { KvFilesystem } from './lib/filesystem/kv-filesystem';
import { KvEasyFilesystem } from './lib/filesystem/kv-easy-filesystem';
import { KvBlockDeviceFs } from './lib/block-device/kv-block-device-fs';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 100;
const TOTAL_NODES = 1000;

const SUPER_BLOCK_ID = 0;

// const password = FileSystemEncryption.keyFromPassword(
//     'password',
//     'salt',
//     100000,
// );

const blockDevice = new KvBlockDeviceFs(
    `${__dirname}/../data`,
    BLOCK_SIZE,
    // new FileSystemEncryption(password),
);

// Create file system

KvFilesystem.format(blockDevice,TOTAL_BLOCKS,TOTAL_NODES);

const fileSystem = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
const easyFileSystem = new KvEasyFilesystem(fileSystem, '/');

// Create test files

easyFileSystem.createDirectory('/home/florin', true);

const testWrite1 = '/home/florin/test1.txt';
easyFileSystem.createFile(testWrite1).write(Buffer.from('hello world'));

const testWrite2 = '/home/florin/test2.txt';
easyFileSystem.createFile(testWrite2).write(Buffer.from('and hello again'));

// Read test files

const testRead1 = easyFileSystem.readFile('/home/florin/test1.txt');
const testRead2 = easyFileSystem.readFile('/home/florin/test2.txt');
const testDir = easyFileSystem.getDirectory('/home/florin');

console.log(testRead1.toString());
console.log(testRead2.toString());
console.log(JSON.stringify(
    [...testDir.read()],
));
