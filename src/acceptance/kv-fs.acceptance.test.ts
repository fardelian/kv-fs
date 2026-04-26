import { describe, it, expect } from '@jest/globals';
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
 * One long, narrative acceptance test for `KvFilesystem`. The flow
 * mirrors how a real user would treat a freshly-formatted volume:
 *
 *   /
 *   ├── TODO.md          (file at depth 0)
 *   ├── notes.txt        (file at depth 0)
 *   ├── docs/
 *   │   └── manual.bin   (multi-block file at depth 1)
 *   ├── tmp/
 *   │   └── scratch-N.txt × 30  (chained-directory exercise)
 *   └── projects/
 *       ├── README.md    (file at depth 1)
 *       ├── alpha/
 *       │   ├── main.ts         (file at depth 2)
 *       │   └── lib/
 *       │       ├── utils.ts    (file at depth 3)
 *       │       └── types.ts    (file at depth 3)
 *       └── beta/
 *           └── main.ts         (file at depth 2)
 *
 * Each operation gets exercised across this tree at multiple depths,
 * and we check both the technical surface (cursor advances, partial
 * ranges, mode semantics, error types) and the user's view (write a
 * file, edit it, move it, refactor the tree, tear it down).
 */
describe('kv-filesystem (acceptance)', () => {
    it('walks a realistic workspace: create → edit → refactor → cleanup', async () => {
        // ---- 1. Format edge cases ----
        {
            const tinyDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * 4);
            await expect(KvFilesystem.format(tinyDevice, 0)).rejects.toThrow(RangeError);
            await expect(KvFilesystem.format(tinyDevice, 1000)).rejects.toThrow(RangeError);
        }

        // ---- 2. Format + open a real volume ----
        const blockDevice = new KvBlockDeviceMemory(BLOCK_SIZE, BLOCK_SIZE * TOTAL_BLOCKS);
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const fs = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const root = await fs.getRootDirectory();
        const rootAgain = await fs.getRootDirectory();
        expect(rootAgain.id).toBe(root.id);
        expect((await root.read()).size).toBe(0);

        // ---- 3. Files in the root directory ----
        const todo = await fs.createFile('TODO.md', root);
        const notes = await fs.createFile('notes.txt', root);
        await fs.write(todo, enc.encode('# Things to do\n- write code\n'));
        // truncate-mode write left the cursor at end-of-data.
        expect(todo.getPos()).toBe('# Things to do\n- write code\n'.length);
        await fs.write(notes, enc.encode('quick scratch'));

        // ---- 4. Reading from the start (explicit start = 0) ----
        expect(dec.decode(await fs.read(todo, 0))).toBe('# Things to do\n- write code\n');
        // After the read, cursor is at EOF.
        expect(todo.getPos()).toBe('# Things to do\n- write code\n'.length);

        // ---- 5. Cursor-aware sequential reads ----
        // '# Things to do\n- write code\n' — read 5 bytes from offset 0,
        // then continue another 7 from wherever the cursor lands.
        await fs.read(todo, 0, 5);
        expect(todo.getPos()).toBe(5);
        const next7 = await fs.read(todo, undefined, 7); // bytes 5..11
        expect(dec.decode(next7)).toBe('ngs to ');
        expect(todo.getPos()).toBe(12);

        // ---- 6. Subdirectories of root ----
        const docs = await fs.createDirectory('docs', root);
        const tmp = await fs.createDirectory('tmp', root);
        const projects = await fs.createDirectory('projects', root);

        // ---- 7. File at depth 1: docs/manual.bin (spans multiple blocks) ----
        const manual = await fs.createFile('manual.bin', docs);
        const manualPayload = new Uint8Array(BLOCK_SIZE * 2 + 100);
        for (let i = 0; i < manualPayload.length; i++) manualPayload[i] = i & 0xff;
        await fs.write(manual, manualPayload);

        // Whole-file readback after seeking to 0.
        const manualBack = await fs.read(manual, 0);
        expect(manualBack.length).toBe(manualPayload.length);
        expect(Array.from(manualBack.subarray(0, 16)))
            .toEqual(Array.from(manualPayload.subarray(0, 16)));

        // Partial read straddling the first block boundary.
        const sliceMid = await fs.read(manual, BLOCK_SIZE - 4, 8);
        expect(sliceMid.length).toBe(8);
        for (let i = 0; i < 8; i++) {
            expect(sliceMid[i]).toBe((BLOCK_SIZE - 4 + i) & 0xff);
        }
        // Cursor lands at start + bytes read.
        expect(manual.getPos()).toBe(BLOCK_SIZE - 4 + 8);

        // ---- 8. File at depth 1: projects/README.md ----
        const readme = await fs.createFile('README.md', projects);
        await fs.write(readme, enc.encode('# My Projects\n'));

        // ---- 9. Directories at depth 2: projects/alpha + projects/beta ----
        const alpha = await fs.createDirectory('alpha', projects);
        const beta = await fs.createDirectory('beta', projects);

        // Files at depth 2.
        const alphaMain = await fs.createFile('main.ts', alpha);
        await fs.write(alphaMain, enc.encode('console.log("alpha");'));
        const betaMain = await fs.createFile('main.ts', beta);
        await fs.write(betaMain, enc.encode('console.log("beta");'));

        // ---- 10. Directory at depth 3 + files inside it ----
        const alphaLib = await fs.createDirectory('lib', alpha);
        const utils = await fs.createFile('utils.ts', alphaLib);
        const types = await fs.createFile('types.ts', alphaLib);
        await fs.write(utils, enc.encode('export const VERSION = "1.0";'));
        await fs.write(types, enc.encode('export type Foo = string;'));

        // ---- 11. Walk the tree by name to reach the depth-3 file ----
        {
            const projectsAgain = await fs.getDirectory('projects', root);
            const alphaAgain = await fs.getDirectory('alpha', projectsAgain);
            const libAgain = await fs.getDirectory('lib', alphaAgain);
            const utilsAgain = await fs.getKvFile('utils.ts', libAgain);
            expect(utilsAgain.id).toBe(utils.id);
            expect(dec.decode(await fs.read(utilsAgain, 0))).toBe('export const VERSION = "1.0";');
        }

        // ---- 12. tmp/ holds enough files to force directory chaining ----
        const FILE_COUNT = 30;
        for (let i = 0; i < FILE_COUNT; i++) {
            const f = await fs.createFile(`scratch-${String(i).padStart(2, '0')}.txt`, tmp);
            await fs.write(f, enc.encode(`scratch ${i}`));
        }
        expect((await tmp.read()).size).toBe(FILE_COUNT);
        // Spot-check a file fetched fresh.
        const spot = await fs.getKvFile('scratch-17.txt', tmp);
        expect(dec.decode(await fs.read(spot, 0))).toBe('scratch 17');

        // ---- 13. Write modes against a small file ----
        // 'truncate' (default) wipes the existing content and writes at 0.
        await fs.write(notes, enc.encode('a'));
        expect(dec.decode(await fs.read(notes, 0))).toBe('a');
        expect(notes.getPos()).toBe(1);

        // 'append' grows the file at EOF; cursor lands at the new EOF.
        await fs.write(notes, enc.encode('b'), 'append');
        await fs.write(notes, enc.encode('c'), 'append');
        expect(dec.decode(await fs.read(notes, 0))).toBe('abc');
        expect(notes.getPos()).toBe(3);

        // 'partial' overwrites in place; cursor lands at offset + data.length.
        await fs.write(notes, enc.encode('Z'), 'partial', 1);
        expect(notes.getPos()).toBe(2);
        expect(dec.decode(await fs.read(notes, 0))).toBe('aZc');

        // 'partial' past EOF zero-fills the gap and grows the file.
        await fs.write(notes, enc.encode('!'), 'partial', 6);
        expect(notes.getPos()).toBe(7);
        const grown = await fs.read(notes, 0);
        expect(grown.length).toBe(7);
        expect(grown[3]).toBe(0); // zero-filled gap
        expect(grown[4]).toBe(0);
        expect(grown[5]).toBe(0);
        expect(grown[6]).toBe('!'.charCodeAt(0));

        // ---- 14. Partial write that crosses a block boundary in a multi-block file ----
        const patch = new Uint8Array([0xab, 0xcd, 0xef]);
        await fs.write(manual, patch, 'partial', BLOCK_SIZE - 1);
        const manual2 = await fs.read(manual, 0);
        expect(manual2[BLOCK_SIZE - 1]).toBe(0xab);
        expect(manual2[BLOCK_SIZE]).toBe(0xcd);
        expect(manual2[BLOCK_SIZE + 1]).toBe(0xef);

        // 'append' onto the multi-block file extends it.
        const sizeBefore = manual.size;
        await fs.write(manual, enc.encode('TAIL'), 'append');
        expect(manual.size).toBe(sizeBefore + 4);
        const manual3 = await fs.read(manual, 0);
        expect(dec.decode(manual3.subarray(sizeBefore))).toBe('TAIL');

        // ---- 15. Refactor: rename a depth-3 file in-place ----
        await fs.rename('utils.ts', alphaLib, 'helpers.ts', alphaLib);
        expect(await alphaLib.hasEntry('utils.ts')).toBe(false);
        expect(await alphaLib.hasEntry('helpers.ts')).toBe(true);
        // The bytes are still reachable through the new name.
        const helpers = await fs.getKvFile('helpers.ts', alphaLib);
        expect(dec.decode(await fs.read(helpers, 0))).toBe('export const VERSION = "1.0";');

        // ---- 16. Refactor: move a depth-3 file up to depth 2 ----
        await fs.rename('helpers.ts', alphaLib, 'helpers.ts', alpha);
        expect(await alphaLib.hasEntry('helpers.ts')).toBe(false);
        expect(await alpha.hasEntry('helpers.ts')).toBe(true);

        // ---- 17. Refactor: rename a directory at depth 2 ----
        await fs.rename('beta', projects, 'gamma', projects);
        expect(await projects.hasEntry('beta')).toBe(false);
        expect(await projects.hasEntry('gamma')).toBe(true);
        // The file inside the renamed directory is reachable via the new path.
        const gamma = await fs.getDirectory('gamma', projects);
        const gammaMain = await fs.getKvFile('main.ts', gamma);
        expect(dec.decode(await fs.read(gammaMain, 0))).toBe('console.log("beta");');

        // ---- 18. Rename refuses to overwrite a destination that already exists ----
        // Both alpha and gamma now contain `main.ts`; renaming one onto the other should fail.
        await expect(fs.rename('main.ts', alpha, 'main.ts', gamma))
            .rejects.toBeInstanceOf(KvError_FS_Exists);
        // Both sides are intact.
        expect(await alpha.hasEntry('main.ts')).toBe(true);
        expect(await gamma.hasEntry('main.ts')).toBe(true);

        // ---- 19. Same-parent same-name rename is a documented no-op ----
        await fs.rename('main.ts', alpha, 'main.ts', alpha);
        expect(await alpha.hasEntry('main.ts')).toBe(true);

        // ---- 20. Missing-source rename throws not-found ----
        await expect(fs.rename('ghost.txt', root, 'wherever.txt', root))
            .rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- 21. removeFile against missing file throws not-found ----
        await expect(fs.removeFile('does-not-exist.txt', root))
            .rejects.toBeInstanceOf(KvError_FS_NotFound);

        // ---- 22. removeDirectory non-recursive: rejects non-empty ----
        await expect(fs.removeDirectory('projects', root))
            .rejects.toBeInstanceOf(KvError_FS_NotEmpty);

        // ---- 23. removeDirectory recursive on a deep tree (covers depth-3 walk) ----
        await fs.removeDirectory('projects', root, true);
        expect(await root.hasEntry('projects')).toBe(false);

        // ---- 24. Tear down the chained `tmp` directory file-by-file ----
        for (let i = 0; i < FILE_COUNT; i++) {
            await fs.removeFile(`scratch-${String(i).padStart(2, '0')}.txt`, tmp);
        }
        expect((await tmp.read()).size).toBe(0);
        await fs.removeDirectory('tmp', root);

        // ---- 25. Final cleanup of the remaining root entries ----
        await fs.removeFile('TODO.md', root);
        await fs.removeFile('notes.txt', root);
        await fs.removeFile('manual.bin', docs);
        await fs.removeDirectory('docs', root);
        expect((await root.read()).size).toBe(0);

        // ---- 26. Volume can be reformatted and re-opened cleanly ----
        await KvFilesystem.format(blockDevice, TOTAL_INODES);
        const reopened = new KvFilesystem(blockDevice, SUPER_BLOCK_ID);
        const reopenedRoot = await reopened.getRootDirectory();
        expect((await reopenedRoot.read()).size).toBe(0);

        // Avoid an unused-binding warning — `betaMain` was useful as a
        // reference earlier (its rename target moved when `beta` →
        // `gamma`).
        expect(betaMain.id).toBeGreaterThan(0);
        // Likewise `alphaMain` and `types` are exercised through the
        // recursive directory walk in step 23 (they get freed there).
        expect(alphaMain.id).toBeGreaterThan(0);
        expect(types.id).toBeGreaterThan(0);
        expect(readme.id).toBeGreaterThan(0);
    });
});
