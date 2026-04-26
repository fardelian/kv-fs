/**
 * Base class for every kv-fs error. Subclasses repeat the
 * `setPrototypeOf` + `this.name` boilerplate explicitly so each one is
 * self-documenting (and so a test that constructs the subclass directly
 * gives `instanceof` and `name` checks the right answer even if a build
 * step ever drops the prototype chain).
 */
export class KvError extends Error {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_Init_Recursion extends KvError {
    constructor() {
        super('The "init" method cannot be decorated with @Init — that would cause infinite recursion.');
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_BD_Overflow extends KvError {
    constructor(dataLengthBytes: number, blockSizeBytes: number) {
        super(`Data size "${dataLengthBytes}" bytes exceeds block size "${blockSizeBytes}" bytes.`);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_BD_NotFound extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_INode_NameOverflow extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

/**
 * Thrown when an inode block's stored `kind` byte doesn't match the
 * subclass trying to read it (e.g. `KvINodeFile` opened over what is
 * actually a directory). The easy-FS layer treats this as a not-found
 * for the wrong-kind lookup. `blockId` is the inode block ID
 * (intentionally typed as `number` here so this file stays at the
 * bottom of the dependency graph and doesn't import from `../inode`).
 */
export class KvError_INode_KindMismatch extends KvError {
    constructor(
        public readonly blockId: number,
        public readonly expectedKind: number,
        public readonly storedKind: number,
    ) {
        super(`Inode at block "${blockId}" has stored kind ${storedKind}, expected ${expectedKind}.`);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_Enc_Key extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_FS_Exists extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_FS_NotFound extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_FS_NotEmpty extends KvError {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvError_FS_FormatVersion extends KvError {
    constructor(found: number, expected: number) {
        super(`On-disk format version "${found}" is not supported by this build (expects "${expected}"). The volume needs to be reformatted or migrated.`);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}
