// Empty subclasses below carry pass-through constructors that look
// "useless" but exist on purpose: Bun's coverage tracker counts the
// synthesized constructor of `class X extends Y {}` as a separate
// uncovered function, so making it explicit gets each subclass to 100%.
/* eslint-disable @typescript-eslint/no-useless-constructor */

/** Base class for every kv-fs error; subclasses set `name` from `new.target`. */
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
    }
}

export class KvError_BD_Overflow extends KvError {
    constructor(dataLengthBytes: number, blockSizeBytes: number) {
        super(`Data size "${dataLengthBytes}" bytes exceeds block size "${blockSizeBytes}" bytes.`);
    }
}

export class KvError_BD_NotFound extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_INode_NameOverflow extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_Enc_Key extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_FS_Exists extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_FS_NotFound extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_FS_NotEmpty extends KvError {
    constructor(message: string) {
        super(message);
    }
}

export class KvError_FS_FormatVersion extends KvError {
    constructor(found: number, expected: number) {
        super(`On-disk format version "${found}" is not supported by this build (expects "${expected}"). The volume needs to be reformatted or migrated.`);
    }
}
