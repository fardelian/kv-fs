import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../../block-devices';
import { KvINodeDirectory, KvINodeFile } from '../';
import { KvError_INode_KindMismatch } from '../../utils';

const BLOCK_SIZE = 4096;
const CAPACITY = BLOCK_SIZE * 16;

describe('KvError_INode_KindMismatch', () => {
    it('fires when KvINodeFile is opened over a directory inode', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY);
        const dirId = await device.allocateBlock();
        await KvINodeDirectory.createEmptyDirectory(device, dirId);

        const wrongKind = new KvINodeFile(device, dirId);

        let caught: unknown;
        try {
            await wrongKind.init();
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(KvError_INode_KindMismatch);
        const error = caught as KvError_INode_KindMismatch;
        expect(error.blockId).toBe(dirId);
        // KvINodeFile.kind is KV_INODE_KIND_FILE (1); the stored block was a directory (0).
        expect(error.expectedKind).toBe(1);
        expect(error.storedKind).toBe(0);
        expect(error.name).toBe('KvError_INode_KindMismatch');
        expect(error.message).toContain(`Inode at block "${dirId}"`);
    });

    it('fires when KvINodeDirectory is opened over a file inode', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY);
        const file = await KvINodeFile.createEmptyFile(device);

        const wrongKind = new KvINodeDirectory(device, file.id);

        await expect(wrongKind.init()).rejects.toBeInstanceOf(KvError_INode_KindMismatch);
    });
});
