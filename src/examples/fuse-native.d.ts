/**
 * Ambient stub for the optional `fuse-native` native module. Only the
 * parts of the API the manual mount example actually touches are
 * described here; the runtime package is installed by the user
 * (see example-sqlite-permanent-fuse-manual.ts → "How to test"). When
 * `fuse-native` is installed for real, its own type declarations
 * shadow this stub.
 */
declare module 'fuse-native' {
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
