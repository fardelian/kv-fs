# kv-fs-examples

Runnable demos for [kv-fs-lib](../kv-fs-lib) — the swappable-block-device filesystem with optional encryption, HTTP transport, and FUSE mounting. Each script in [`src/`](src/) wires the lib together in a different shape (in-memory, local-disk, SQLite, HTTP client / server, FUSE adapter, real FUSE mount). For the design, on-disk format, and public API, see kv-fs-lib's README.

It is a pet project. Don't trust it with anything you'd miss.

## Try it

```bash
npm install

npm run start-memory                        # in-memory, ephemeral
npm run start-local-fs-permanent            # local disk, persists across runs
npm run start-sqlite                        # SQLite, ephemeral (formats every run)
npm run start-sqlite-permanent              # SQLite, persists across runs
npm run start-sqlite-permanent-fuse-auto    # SQLite + in-process FUSE handlers (no real mount)
npm run start-sqlite-permanent-fuse-manual  # SQLite + real FUSE mount; drops you into zsh
npm run start-http-server                   # serve a block device over HTTP
npm run start-http-client                   # (in another terminal) drive the remote device
```

Each script logs `[N/STEP_COUNT]` step headers, drops a `/YYYY-MM-DD/HH-MM-SS.txt` timestamp file inside the kv-fs on every run (the permanent ones list every prior run's timestamps too), and ends with the device's metadata + a `time:` total runtime.

The simplest entry point is [`src/example-memory.ts`](src/example-memory.ts) — a few dozen lines from "open device" to "read a file back." For a more elaborate flow, run `start-http-server` in one terminal and `start-http-client` in another: the client wraps the HTTP transport with `KvEncryptionPassword` so the server only ever sees ciphertext (zero-knowledge over the wire), while the server demonstrates that encryption is itself a block device by stacking `KvEncryptionRot13` over SQLite at rest (the rot13 part is for the demo — swap in a real cipher in production, or skip the server-side layer entirely).

## Mounting via FUSE

The manual FUSE example loads [`@cocalc/fuse-native`](https://www.npmjs.com/package/@cocalc/fuse-native) and mounts the kv-fs at a real OS mount point. We use the cocalc fork rather than the original [`fuse-native`](https://www.npmjs.com/package/fuse-native): the original has been unmaintained since 2021 and its native binary segfaults inside `mount()` on recent macOS (macFUSE 4+ / Apple Silicon). The cocalc fork keeps the same API and rebuilds against modern macFUSE / FUSE-T / libfuse.

`@cocalc/fuse-native` is declared as an `optionalDependency`, so `npm install` will compile it on systems where the OS-level FUSE library is present and silently skip it everywhere else.

To run the manual mount example:

1. **Install the OS-level FUSE library** (one-time):
    - **macOS** — install [macFUSE](https://osxfuse.github.io/) or [FUSE-T](https://www.fuse-t.org/). FUSE-T is kext-free and is usually the easier setup on Apple Silicon.
    - **Linux** — `apt install libfuse-dev` (Debian/Ubuntu) or `dnf install fuse3-devel` (Fedora). The kernel module ships with most distros.
2. **Install `pkg-config`** (one-time): the `node-gyp` build for `@cocalc/fuse-native` shells out to `pkg-config` to discover the FUSE library paths. Without it the build fails with `pkg-config: command not found`, npm silently drops the optional dep, and `npm install` looks like it succeeded.
    - **macOS** — `brew install pkg-config`.
    - **Linux** — `apt install pkg-config` (Debian/Ubuntu) or `dnf install pkgconf-pkg-config` (Fedora).
3. **Install the project** (compiles `fuse-native`):

   ```bash
   npm install
   ```

   If you'd run `npm install` previously without the OS library or `pkg-config`, npm won't retry the optional dep on its own. Wipe and reinstall:

   ```bash
   rm -rf node_modules package-lock.json && npm install
   ```
4. **Run the example**:

   ```bash
   npm run start-sqlite-permanent-fuse-manual
   ```

   Default mount point is `/tmp/kvfs-manual`; override with the `KVFS_MOUNT` environment variable. The example mounts, then spawns `zsh` with `$KVFS_MOUNT` exported and the shell already inside the mount.
5. **Drive the volume from inside the shell**:

   ```bash
   ls -al
   cat README.txt
   echo 'hello' > greet.txt
   echo ' world' >> greet.txt
   cat greet.txt
   df .
   ```

   The kv-fs state lives in `data/data.sqlite3` (table `blocks_fuse_manual`) and persists across runs.
6. **Exit the shell** (`exit` / Ctrl+D) to unmount cleanly. The shutdown path runs `fuse.unmount → KvFilesystem.flush() → database.close() → exit 0`. SIGTERM from outside has the same effect.

If a crash leaves the mount stale, force-unmount with `umount /tmp/kvfs-manual` (Linux) or `diskutil unmount /tmp/kvfs-manual` (macOS) before restarting.

## Author

Florin Ardelian — <florin@ardelian.ro>

## License

**PROPRIETARY.** Please ask before using.
