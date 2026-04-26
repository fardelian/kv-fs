/**
 * Ambient stub for the optional `@cocalc/fuse-native` native module
 * (the actively-maintained fork of `fuse-native` — same API, builds
 * cleanly against modern macFUSE / FUSE-T / libfuse). Only the parts
 * of the API the manual mount example actually touches are described
 * here; the runtime package is installed via `optionalDependencies`
 * in package.json. When `@cocalc/fuse-native` is installed for real,
 * its own type declarations shadow this stub.
 */
declare module '@cocalc/fuse-native' {
    interface FuseInstance {
        mount(cb: (err: Error | null) => void): void;
        unmount(cb: (err: Error | null) => void): void;
    }
    type FuseConstructor = new (
        mountPoint: string,
        ops: Record<string, unknown>,
        opts?: { force?: boolean; mkdir?: boolean; debug?: boolean },
    ) => FuseInstance;
    const Fuse: FuseConstructor;
    export default Fuse;
}
