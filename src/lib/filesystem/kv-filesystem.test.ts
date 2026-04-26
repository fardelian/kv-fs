import { describe, it, expect } from 'test-globals';
import { KvBlockDeviceMemory } from '../block-devices';
import { KvFilesystem } from './kv-filesystem';

const BLOCK_SIZE = 4096;
const CAPACITY_BLOCKS = 16;
const CAPACITY_BYTES = BLOCK_SIZE * CAPACITY_BLOCKS;

describe('KvFilesystem.format', () => {
    it('throws RangeError when totalINodes is less than 1', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        await expect(KvFilesystem.format(device, 0)).rejects.toBeInstanceOf(RangeError);
    });

    it('throws RangeError when totalINodes exceeds the device capacity in blocks', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        await expect(KvFilesystem.format(device, CAPACITY_BLOCKS + 1))
            .rejects.toBeInstanceOf(RangeError);
    });

    it('returns a KvFilesystem with the configured superblock when totalINodes is in range', async () => {
        const device = new KvBlockDeviceMemory(BLOCK_SIZE, CAPACITY_BYTES);

        const fs = await KvFilesystem.format(device, 4);

        expect(fs).toBeInstanceOf(KvFilesystem);
    });
});
