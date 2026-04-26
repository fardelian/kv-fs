# kv-fs

A tiny filesystem you can lay on top of any kind of block storage. Backends are swappable — in-memory, local disk, SQLite, an HTTP server — and any of them can be wrapped in transparent encryption. Built in TypeScript for fun, mostly to see how a hand-rolled superblock / inode / data-block layout actually feels in practice.

It is a pet project. It is almost certainly full of bugs. Do not trust it with anything you would miss.

## What's in the box

- [**`KvBlockDevice`**](src/lib/block-devices/helpers/kv-block-device.ts) — the storage interface: `readBlock`, `writeBlock`, `freeBlock`, `existsBlock`, `allocateBlock`. Implement this and you have a new backend.
- **Backends** —
    - [`KvBlockDeviceMemory`](src/lib/block-devices/kv-block-device-memory.ts): blocks live in a `Map` in process memory. Ephemeral; great for tests, demos, browsers.
    - [`KvBlockDeviceFs`](src/lib/block-devices/kv-block-device-fs.ts): one file per block on the local filesystem.
    - [`KvBlockDeviceSqlite3`](src/lib/block-devices/kv-block-device-sqlite3.ts): one row per block in a SQLite database.
    - [`KvBlockDeviceHttpClient`](src/lib/block-devices/kv-block-device-http-client.ts) + [`KvBlockDeviceHttpRouter`](src/lib/block-devices/kv-block-device-http-router.ts): talk to a remote block device over a small HTTP API.
- [**`KvEncryptedBlockDevice`**](src/lib/block-devices/kv-encrypted-block-device.ts) — a decorator that wraps any block device with transparent encryption. Pair it with one of:
    - [`KvEncryptionAES256GCMKey`](src/lib/encryption/kv-encryption-aes-256-gcm-key.ts) — AEAD (authenticated encryption). Fresh 12-byte nonce per write, 16-byte auth tag, block ID mixed in as additional authenticated data; tampering is detected on read. Adds 28 bytes of overhead per block. The recommended cipher for zero-knowledge storage.
    - [`KvEncryptionAES256XTSKey`](src/lib/encryption/kv-encryption-aes-256-xts-key.ts) — length-preserving (no padding, no stored IV); the block ID is used as the XTS tweak. Unauthenticated — bit-flips go undetected; pair with a separate integrity layer if you need that.
    - [`KvEncryptionAES256CBCKey`](src/lib/encryption/kv-encryption-aes-256-cbc-key.ts) — random IV stored with each block, PKCS#7 padding. Adds 32 bytes of overhead per block.
    - [`KvEncryptionPassword`](src/lib/encryption/kv-encryption-password.ts) — derives an AES-256-CBC key from a password via PBKDF2.
    - [`KvEncryptionRot13`](src/lib/encryption/kv-encryption-rot13.ts) — for entertainment value (don't @ me).
- [**`KvFilesystem`**](src/lib/filesystem/kv-filesystem.ts) — superblock, inodes ([file](src/lib/inode/kv-inode-file.ts) + [directory](src/lib/inode/kv-inode-directory.ts)), block allocation, format. Layered on top of any block device.
- [**`KvFilesystemSimple`**](src/lib/filesystem/kv-filesystem-simple.ts) — path-style helpers (`createFile('/home/florin/note.txt')`, `readDirectory('/')`) so callers don't have to thread inodes around.

## How it works

The filesystem only ever talks to one abstraction: the **block device**. A block device is a flat array of fixed-size blocks addressed by integer IDs, with a handful of operations:

- `readBlock(id) → Uint8Array`
- `writeBlock(id, data)`
- `freeBlock(id)`
- `existsBlock(id) → boolean`
- `allocateBlock() → id` — allocate a fresh, unused block

That's the entire contract. Everything above it works in terms of "give me block 7" and "store these bytes in block 12." It doesn't know — and doesn't need to know — whether the bytes end up in a file on disk, a row in SQLite, or an HTTP `POST` to another machine.

### Backends are interchangeable

Because the contract is so small, swapping the backing store is a one-line change at the top of the program. The same `KvFilesystem` that ran on a local-disk block device runs unchanged on top of:

- `KvBlockDeviceMemory` — blocks live in a `Map` in process memory. Vanishes when the process exits.
- `KvBlockDeviceFs` — one file per block on the local filesystem (`./data/0.txt`, `./data/1.txt`, …).
- `KvBlockDeviceSqlite3` — one row per block in a SQLite table.
- `KvBlockDeviceHttpClient` — every block operation becomes an HTTP request to a remote server. On the other side, `KvBlockDeviceHttpRouter` exposes any block device over HTTP, so you can stack a client against a remote server that's actually backed by SQLite or local files.

Write your own — anything that satisfies the five operations is a valid backend.

### Encryption is a wrapper, not a feature

`KvEncryptedBlockDevice` *is itself a block device*. On write it takes a block, encrypts it, and hands it to a wrapped block device. On read it fetches from that wrapped device, decrypts, and returns. The filesystem on top has no idea encryption is happening — it just sees a normal block device that happens to scramble bytes in transit.

The simplest stack is one block device:

```
  KvFilesystem
       │
       ▼
  KvBlockDeviceMemory  ──  blocks live in a Map; gone on process exit
```

Because every layer in the stack speaks the same `KvBlockDevice` language, you can compose them freely. A heavier stack might swap the backing store, add encryption, and go over the network:

```
  KvFilesystem
       │
       ▼
  KvEncryptedBlockDevice  ──  encrypts on write, decrypts on read
       │
       ▼
  KvBlockDeviceHttpClient ──  serializes block ops over HTTP
                                  ⇅
                          KvBlockDeviceHttpRouter (server)
                                  │
                                  ▼
                          KvBlockDeviceSqlite3       ──  blocks land in a SQLite row
```

The filesystem writes a directory entry → the encryption layer wraps the bytes → the HTTP client sends them over the wire → the server's router hands them to the SQLite block device → they land in a row. The filesystem never knew any of that happened.

### Encryption schemes have an overhead, and we account for it

Some ciphers add bytes (a stored IV, padding, an auth tag); others don't. The `KvEncryption` contract makes that explicit:

```ts
interface KvEncryption {
    readonly overheadBytes: number;
    encrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;
    decrypt(blockId: number, data: Uint8Array): Promise<Uint8Array>;
}
```

`KvEncryptedBlockDevice` reads `overheadBytes` from its cipher and exposes a block size of `wrapped.blockSize - overheadBytes` to the filesystem. So a full encrypted block (plaintext + IV + tag + padding) fits exactly into one underlying block, regardless of the scheme.

Concrete numbers for the schemes shipped here:

| Scheme | `overheadBytes` | Notes |
|---|---|---|
| `KvEncryptionRot13` / Caesar | 0 | length-preserving by construction |
| `KvEncryptionAES256XTSKey` | 0 | XTS uses the block ID as a tweak; no IV is stored, no padding is added |
| `KvEncryptionAES256GCMKey` | 28 | 12-byte random nonce + 16-byte auth tag; AEAD with the block ID as additional authenticated data |
| `KvEncryptionAES256CBCKey` / `KvEncryptionPassword` | 32 | 16-byte random IV + one full PKCS#7 padding block |

The `blockId` argument is part of the unified API — tweakable schemes (XTS) use it as the per-block tweak; non-tweakable schemes (CBC, ROT13) ignore it. That keeps a single `encrypt(blockId, data)` shape for everyone, while still leaving room for length-preserving disk-encryption modes that *need* the block ID.

### What's on top of the block device

The filesystem itself is built out of those same blocks:

- **Superblock** — block 0 by convention. Holds layout constants (total blocks, block size, total inodes) and the ID of the root directory's inode.
- **Inodes** — each file or directory lives in one inode block. The block starts with metadata (creation / modification time) and is followed by type-specific content:
    - A **file** inode stores its size and the list of data-block IDs that hold its bytes.
    - A **directory** inode stores `(name, inode-id)` entries inline. Entries are variable-length (a 16-bit name length + the UTF-8 bytes + a 32-bit inode ID), packed densely. When entries overflow the inode block, the directory chains into additional **continuation blocks** (allocated via `allocateBlock()`); the last 8 bytes of every block hold a 32-bit per-block entry count followed by the 32-bit next-block ID (or `0xFFFFFFFF` to terminate the chain). Directory size is unbounded.
- **Data blocks** — owned by file inodes. Allocated via `allocateBlock()` when a file grows; freed when it shrinks or is unlinked.

That's the whole model. Reading a directory means reading its inode block and following the next-block pointer through any continuation blocks until enough entries have been collected. Opening a file by path means walking from the root directory through `(name, inode-id)` lookups until you reach the file's inode. Reading the file means following its data-block list and concatenating.

`KvFilesystemSimple` is a thin convenience layer on top — it walks paths for you so callers don't have to resolve each path component by hand.

### Files have a position

[`KvINodeFile`](src/lib/inode/kv-inode-file.ts) keeps a current read/write position, like an open `FILE *` in C. The shape is loosely modeled on POSIX:

- `getPos()` — current offset, in bytes from the start. (`ftell` analogue.)
- `setPos(n)` — move the offset. Setting it past EOF **extends** the file with zero bytes (POSIX `lseek` doesn't extend; this method does, by design).
- `truncate(n)` — set the size, like POSIX `ftruncate(3p)`. Extending zero-fills; shrinking frees trailing data blocks. Position is not modified.
- `read(length?)` — read up to `length` bytes (or to EOF if omitted) from the current position; advances the position.
- `write(data)` — write `data` at the current position; advances the position; extends the file if it spills past EOF; **does not shrink** when overwriting in place — use `truncate(0)` first if you want a full replace.

The "extended area shall appear as if it were zero-filled" guarantee holds across `truncate`-shrink-then-extend too: shrinking zeroes the partial tail of the last retained block before freeing the rest, so a later extend reads as zero rather than uncovering stale bytes.

## Try it

```bash
npm install

npm run start-memory       # filesystem in process memory (no disk)
npm run start-local-fs     # filesystem backed by local disk
npm run start-sqlite       # filesystem backed by a SQLite database
npm run start-http-server  # serve a block device over HTTP
npm run start-http-client  # in another terminal: mount the remote block device as a filesystem
```

All examples output the same thing.

The simplest example is in `src/examples/example-memory.ts`. Start from there, read it and play around with it.

For a more complex example, run `start-http-server` in a terminal and then `start-http-client` in another one.
The server uses the express router in [`kv-block-device-http-router.ts`](src/lib/block-devices/kv-block-device-http-router.ts)
to map block-device methods to HTTP endpoints, with SQLite as the backing store. Both sides
wrap their own block device with `KvEncryptedBlockDevice`, but for different reasons:

- The **client** wraps the HTTP transport with `KvEncryptionPassword` (PBKDF2 → AES-256-CBC).
  Plaintext never leaves the client — the server only ever sees AES ciphertext on the wire and
  at rest. That is the zero-knowledge property: the server can't read your files even if it
  wants to.
- The **server** wraps SQLite with `KvEncryptionRot13`, purely to demonstrate that encryption
  is itself a block device and stacks like any other layer. ROT13 is a toy; in a real
  deployment you would swap it for a real at-rest cipher (or skip server-side encryption
  entirely if the disk is already trusted). What gives you confidentiality against the server
  is the *client-side* layer.

### Mounting via FUSE

There are two FUSE examples; they target the same `KvFuseHandlers` adapter from different angles:

- [`example-sqlite-permanent-fuse-auto.ts`](src/examples/example-sqlite-permanent-fuse-auto.ts) — drives the FUSE handler API in-process. Useful as a smoke test or a tour of the adapter; does **not** actually mount, so you don't need any system FUSE library to run it. `npm run start-sqlite-permanent-fuse`.
- [`example-sqlite-permanent-fuse-manual.ts`](src/examples/example-sqlite-permanent-fuse-manual.ts) — *really* mounts the kv-fs at an OS mount point via [`fuse-native`](https://www.npmjs.com/package/fuse-native), then drops you into a `bash` session with `$KVFS_MOUNT` pointing at the mount. `ls`, `cat`, `echo >>`, `cp`, `df`, `touch`, `chmod` (silently ignored) all flow through the kernel into our handlers.

`fuse-native` is declared as an `optionalDependency` and as a `trustedDependency`, so `bun install` will compile it (and run its postinstall to fetch / build the native binary) on systems where the OS-level FUSE library is present, and silently skip it everywhere else. There's no `bun add` step.

This particular example runs under [`tsx`](https://www.npmjs.com/package/tsx) (Node + TypeScript loader) rather than bun. As of bun 1.3, Bun's NAPI loader segfaults when `fuse-native` is imported — Node loads the same binding cleanly. Every other script in the project still runs under bun; only this one is special.

To run the manual mount example:

1. **Install the OS-level FUSE library** (one-time):
    - **macOS** — install [macFUSE](https://osxfuse.github.io/) or [FUSE-T](https://www.fuse-t.org/). FUSE-T is kext-free and is usually the easier setup on Apple Silicon.
    - **Linux** — `apt install libfuse-dev` (Debian/Ubuntu) or `dnf install fuse3-devel` (Fedora). The kernel module ships with most distros.
2. **Install the project** (compiles `fuse-native`):

   ```bash
   bun install
   ```

   If you'd run `bun install` previously without the OS library, bun won't retry the optional dep on its own. Force it with:

   ```bash
   bun install --force
   ```

   You may see `Blocked N postinstall. Run \`bun pm untrusted\` for details.` — bun blocks postinstall scripts from packages it doesn't recognise. `fuse-native` is in the `trustedDependencies` allow-list in [`package.json`](package.json), so this should clear itself; if it doesn't, run `bun pm trust fuse-native` once and then `bun install --force`.
3. **Run the example**:

   ```bash
   npm run start-sqlite-permanent-fuse-manual
   ```

   Default mount point is `/tmp/kvfs-manual`; override with the `KVFS_MOUNT` environment variable. The example mounts, then spawns `bash` with `$KVFS_MOUNT` exported.
4. **Drive the volume from inside the shell**:

   ```bash
   ls -al "$KVFS_MOUNT"
   echo 'hello' > "$KVFS_MOUNT/greet.txt"
   echo ' world' >> "$KVFS_MOUNT/greet.txt"
   cat "$KVFS_MOUNT/greet.txt"
   df "$KVFS_MOUNT"
   ```

   The kv-fs state lives in `data/data.sqlite3` (table `blocks_fuse_manual`) and persists across runs.
5. **Exit the shell** (`exit` / Ctrl+D) to unmount cleanly. The shutdown path runs `fuse.unmount → KvFilesystem.flush() → database.close() → exit 0`. SIGTERM from outside has the same effect.

If a crash leaves the mount stale, force-unmount with `umount /tmp/kvfs-manual` (Linux) or `diskutil unmount /tmp/kvfs-manual` (macOS) before restarting.

## Tests

Two flavors:

- **Unit tests** live next to the code they test (`src/**/*.test.ts`). They cover individual classes in isolation, using mocks for any I/O.
- **Acceptance tests** live in [`src/acceptance/`](src/acceptance/). They drive the public API end-to-end against an in-memory backend, the same way the examples do — but as automated checks.

```bash
npm test                 # run everything (unit + acceptance)
npm run test:acceptance  # only the acceptance suite
npm run typecheck        # type-only check across the project
```

## Author

Florin Ardelian — <florin@ardelian.ro>

## License

**PROPRIETARY.** Please ask before using.
