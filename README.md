# kv-fs

A tiny filesystem you can lay on top of any kind of block storage. Backends are swappable — in-memory, local disk, SQLite, an HTTP server — and any of them can be wrapped in transparent encryption. Built in TypeScript for fun, mostly to see how a hand-rolled superblock / inode / data-block layout actually feels in practice.

It is a pet project. It is almost certainly full of bugs. Do not trust it with anything you would miss.

## What's in the box

- [**`KvBlockDevice`**](src/lib/block-devices/kv-block-device.base.ts) — the storage interface: `readBlock`, `writeBlock`, `freeBlock`, `existsBlock`, `allocateBlock`. Implement this and you have a new backend.
- **Backends** —
    - [`KvBlockDeviceMemory`](src/lib/block-devices/kv-block-device-memory.ts): blocks live in a `Map` in process memory. Ephemeral; great for tests, demos, browsers.
    - [`KvBlockDeviceFs`](src/lib/block-devices/kv-block-device-fs.ts): one file per block on the local filesystem.
    - [`KvBlockDeviceSqlite3`](src/lib/block-devices/kv-block-device-sqlite3.ts): one row per block in a SQLite database.
    - [`KvBlockDeviceHttpClient`](src/lib/block-devices/kv-block-device-http-client.ts) + [`KvBlockDeviceExpressRouter`](src/lib/block-devices/kv-block-device-express-router.ts): talk to a remote block device over a small HTTP API.
- [**`KvEncryptedBlockDevice`**](src/lib/block-devices/kv-encrypted-block-device.ts) — a decorator that wraps any block device with transparent encryption. Pair it with [`KvEncryptionKey`](src/lib/encryption/kv-encryption-key.ts), [`KvEncryptionPassword`](src/lib/encryption/kv-encryption-password.ts), or [`KvEncryptionNone`](src/lib/encryption/kv-encryption-none.ts).
- [**`KvFilesystem`**](src/lib/filesystem/kv-filesystem.ts) — superblock, inodes ([file](src/lib/inode/kv-inode-file.ts) + [directory](src/lib/inode/kv-inode-directory.ts)), block allocation, format. Layered on top of any block device.
- [**`KvFilesystemEasy`**](src/lib/filesystem/kv-filesystem-easy.ts) — path-style helpers (`createFile('/home/florin/note.txt')`, `readDirectory('/')`) so callers don't have to thread inodes around.

## How it works

The filesystem only ever talks to one abstraction: the **block device**. A block device is a flat array of fixed-size blocks addressed by integer IDs, with a handful of operations:

- `readBlock(id) → Buffer`
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
- `KvBlockDeviceHttpClient` — every block operation becomes an HTTP request to a remote server. On the other side, `KvBlockDeviceExpressRouter` exposes any block device over HTTP, so you can stack a client against a remote server that's actually backed by SQLite or local files.

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
                          KvBlockDeviceExpressRouter (server)
                                  │
                                  ▼
                          KvBlockDeviceSqlite3       ──  blocks land in a SQLite row
```

The filesystem writes a directory entry → the encryption layer wraps the bytes → the HTTP client sends them over the wire → the server's router hands them to the SQLite block device → they land in a row. The filesystem never knew any of that happened.

### What's on top of the block device

The filesystem itself is built out of those same blocks:

- **Superblock** — block 0 by convention. Holds layout constants (total blocks, block size, total inodes) and the ID of the root directory's inode.
- **Inodes** — each file or directory lives in one inode block. The block starts with metadata (creation / modification time) and is followed by type-specific content:
    - A **file** inode stores its size and the list of data-block IDs that hold its bytes.
    - A **directory** inode stores `(name, inode-id)` entries inline (no separate data blocks, so directory size is bounded by the block size).
- **Data blocks** — owned by file inodes. Allocated via `allocateBlock()` when a file grows; freed when it shrinks or is unlinked.

That's the whole model. Reading a directory means reading its inode block and parsing entries. Opening a file by path means walking from the root directory through `(name, inode-id)` lookups until you reach the file's inode. Reading the file means following its data-block list and concatenating.

`KvFilesystemEasy` is a thin convenience layer on top — it walks paths for you so callers don't have to resolve each path component by hand.

## Try it

```bash
npm install

npm run start-memory       # filesystem in process memory (no disk)
npm run start-local-fs     # filesystem backed by local disk
npm run start-sqlite       # filesystem backed by a SQLite database
npm run start-http-server  # serve a block device over HTTP
npm run start-http-client  # in another terminal: mount the remote block device as a filesystem
```

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
