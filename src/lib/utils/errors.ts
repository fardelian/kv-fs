abstract class KvError extends Error {
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
}

export class KvError_INode_NameOverflow extends KvError {
}

export class KvError_Enc_Key extends KvError {
}

export class KvError_FS_Exists extends KvError {
}

export class KvError_FS_NotFound extends KvError {
}
