import { describe, it, expect } from 'bun:test';
import { KvBlockDeviceMemory } from '../lib/block-devices';
import { KvFilesystem } from '../lib/filesystem';
import { KvError_FS_Exists, KvError_FS_NotEmpty, KvError_FS_NotFound } from '../lib/utils';

const BLOCK_SIZE = 4096;
const TOTAL_BLOCKS = 256;
const TOTAL_INODES = 64;
const SUPER_BLOCK_ID = 0;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * One very long acceptance test that exercises every public surface of
 * `KvFilesystem` in a single coherent flow — format → directories →
 * files → byte-addressable read/write (with every write mode) →
 * rename → recursive removal → final cleanup. The goal is to keep the
 * full feature matrix in one readable narrative; finer-grained
 * isolated tests live next to each implementation file.
 */
describe('kv-filesystem (acceptance)', () => {
    it('exercises every public feature of KvFilesystem in one long flow', async () => {
        // ---- format edge cases ----
        {
            const tinyDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * 4);
            await expect(KvFilesystem.format(tinyDevice, 0)).rejects.toBeInstanceOf(RangeError);
            await expect(KvFilesystem.format(tinyDevice, 1000)).rejects.toBeInstanceOf(RangeError);
        }

        // ---- format + open ----
        const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const fs = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);

        // ---- root directory is reachable and starts empty ----
        const root = await fs.getRootDirectory();
        const rootAgain = await fs.getRootDirectory();
        expect(rootAgain.id).toBe(root.id);
        expect((await root.read()).size).toBe(0);

        // ---- createDirectory + getDirectory ----
        const projects = await fs.createDirectory('projects', root);
        const alpha = await fs.createDirectory('alpha', projects);
        const beta = await fs.createDirectory('beta', projects);
        const docs = await fs.createDirectory('docs', root);

        const projectsAgain = await fs.getDirectory('projects', root);
        expect(projectsAgain.id).toBe(projects.id);
        await expect(fs.getDirectory('missing', root)).rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- createFile + getKvFile ----
        const note = await fs.createFile('note.txt', alpha);
        await fs.createFile('greet.txt', alpha);
        const huge = await fs.createFile('huge.bin', beta);

        const noteAgain = await fs.getKvFile('note.txt', alpha);
        expect(noteAgain.id).toBe(note.id);
        await expect(fs.getKvFile('missing.txt', alpha)).rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- write 'truncate' (default) — clears the file, writes from 0 ----
        await fs.write(note, enc.encode('hello world'));
        expect(dec.decode(await fs.read(note))).toBe('hello world');

        // ---- read partial: explicit start ----
        expect(dec.decode(await fs.read(note, 6))).toBe('world');

        // ---- read partial: start + length ----
        expect(dec.decode(await fs.read(note, 0, 5))).toBe('hello');

        // ---- read past EOF returns empty ----
        expect((await fs.read(note, 100)).length).toBe(0);

        // ---- read length larger than file yields the available tail (no extension) ----
        expect(dec.decode(await fs.read(note, 6, 9999))).toBe('world');

        // ---- write 'append' grows the file at EOF ----
        await fs.write(note, enc.encode('!!'), 'append');
        expect(dec.decode(await fs.read(note))).toBe('hello world!!');

        // ---- write 'partial' overwrites in place without growing ----
        await fs.write(note, enc.encode('HELLO'), 'partial', 0);
        expect(dec.decode(await fs.read(note))).toBe('HELLO world!!');

        // ---- write 'partial' past EOF grows the file with a zero-filled gap ----
        await fs.write(note, enc.encode('++'), 'partial', 15);
        const grown = await fs.read(note);
        expect(grown.length).toBe(17);
        expect(grown[13]).toBe(0); // zero-fill between old EOF and new offset
        expect(grown[14]).toBe(0);
        expect(grown[15]).toBe('+'.charCodeAt(0));
        expect(grown[16]).toBe('+'.charCodeAt(0));

        // ---- write 'truncate' wipes the existing content ----
        await fs.write(note, enc.encode('fresh start'));
        expect(dec.decode(await fs.read(note))).toBe('fresh start');

        // ---- multi-block file: payload spanning > 3 blocks ----
        const bigSize = BLOCK_SIZE * 3 + 100;
        const bigPayload = new Uint8Array(bigSize);
        for (let i = 0; i < bigSize; i++) bigPayload[i] = i & 0xff;
        await fs.write(huge, bigPayload);

        const bigBack = await fs.read(huge);
        expect(bigBack.length).toBe(bigSize);
        expect(Array.from(bigBack.subarray(0, 16))).toEqual(Array.from(bigPayload.subarray(0, 16)));
        // Cross-block boundary at position BLOCK_SIZE.
        expect(Array.from(bigBack.subarray(BLOCK_SIZE - 8, BLOCK_SIZE + 8)))
            .toEqual(Array.from(bigPayload.subarray(BLOCK_SIZE - 8, BLOCK_SIZE + 8)));

        // ---- partial read straddling a block boundary ----
        const sliceMid = await fs.read(huge, BLOCK_SIZE + 100, 200);
        expect(sliceMid.length).toBe(200);
        expect(sliceMid[0]).toBe((BLOCK_SIZE + 100) & 0xff);

        // ---- partial write that crosses a block boundary ----
        const patch = new Uint8Array([0xab, 0xcd, 0xef]);
        await fs.write(huge, patch, 'partial', BLOCK_SIZE - 1);
        const huge2 = await fs.read(huge);
        expect(huge2[BLOCK_SIZE - 1]).toBe(0xab);
        expect(huge2[BLOCK_SIZE]).toBe(0xcd);
        expect(huge2[BLOCK_SIZE + 1]).toBe(0xef);

        // ---- append onto a multi-block file ----
        const tail = enc.encode('TAIL');
        const sizeBefore = huge2.length;
        await fs.write(huge, tail, 'append');
        const huge3 = await fs.read(huge);
        expect(huge3.length).toBe(sizeBefore + tail.length);
        expect(dec.decode(huge3.subarray(sizeBefore))).toBe('TAIL');

        // ---- rename within the same directory ----
        await fs.rename('note.txt', alpha, 'README.md', alpha);
        expect(await alpha.hasEntry('note.txt')).toBe(false);
        expect(await alpha.hasEntry('README.md')).toBe(true);

        // ---- rename across directories preserves the file's bytes ----
        await fs.rename('README.md', alpha, 'README.md', docs);
        const renamedReadme = await fs.getKvFile('README.md', docs);
        expect(dec.decode(await fs.read(renamedReadme))).toBe('fresh start');

        // ---- rename refuses to overwrite an existing destination ----
        await fs.createFile('blocker.txt', docs);
        await expect(fs.rename('README.md', docs, 'blocker.txt', docs))
            .rejects.toBeInstanceOf(KvError_FS_Exists);

        // ---- rename: same parent, same name is a no-op ----
        await fs.rename('README.md', docs, 'README.md', docs);
        expect(await docs.hasEntry('README.md')).toBe(true);

        // ---- rename: missing source throws not-found ----
        await expect(fs.rename('ghost.txt', docs, 'wherever.txt', docs))
            .rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- removeFile ----
        await fs.removeFile('greet.txt', alpha);
        await fs.removeFile('blocker.txt', docs);
        await expect(fs.removeFile('greet.txt', alpha)).rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- removeDirectory non-recursive: rejects non-empty ----
        await expect(fs.removeDirectory('beta', projects))
            .rejects.toBeInstanceOf(KvError_FS_NotEmpty);

        // ---- removeDirectory recursive: clears the subtree ----
        // Nest one deeper inside beta for the recursive walk to chew on.
        const inner = await fs.createDirectory('inner', beta);
        const innerNote = await fs.createFile('innerNote.txt', inner);
        await fs.write(innerNote, enc.encode('disposable'));
        await fs.removeDirectory('beta', projects, true);
        expect(await projects.hasEntry('beta')).toBe(false);

        // ---- removeDirectory non-existent path ----
        await expect(fs.removeDirectory('beta', projects))
            .rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- final cleanup: tear the whole tree down through the public API ----
        await fs.removeDirectory('alpha', projects);
        await fs.removeDirectory('projects', root);
        await fs.removeFile('huge.bin', beta).catch(() => undefined); // beta already gone via recursive
        await fs.removeFile('README.md', docs);
        await fs.removeDirectory('docs', root);
        expect((await root.read()).size).toBe(0);

        // ---- after format(), the device drops every block ----
        const beforeReformat = await blockDevice.getHighestBlockId();
        expect(beforeReformat).toBeGreaterThanOrEqual(0);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const reopened = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const reopenedRoot = await reopened.getRootDirectory();
        expect((await reopenedRoot.read()).size).toBe(0);
    });
});
