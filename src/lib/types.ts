export abstract class Init {
    private _initialized: boolean = false;

    protected async init(): Promise<this> {
        this._initialized = true;

        return this;
    }

    checkInit(): void {
        if (!this._initialized) {
            throw new KvInitError();
        }
    }
}

export abstract class KvError extends Error {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = new.target.name;
    }
}

export class KvInitError extends KvError {
    constructor() {
        super('Object not initialized. Call init() first.');
    }
}

export class KvError_BD_Overflow extends KvError {
}

export class KvError_Enc_Key extends KvError {
}

export class KvError_FS_Exists extends KvError {
}

export class KvError_FS_NotFound extends KvError {
}
