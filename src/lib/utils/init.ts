import { KvError_Init_Recursion } from './errors';

interface HasInit {
    init(): Promise<void>;
}

const inflight = new WeakMap<object, Promise<unknown>>();

const ready = new WeakSet();

export function Init<This extends HasInit, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Promise<Return>,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
) {
    if (ctx.name === 'init') {
        throw new KvError_Init_Recursion();
    }

    return async function (this: This, ...args: Args): Promise<Return> {
        if (!ready.has(this)) {
            let pending = inflight.get(this);

            if (!pending) {
                pending = this.init()
                    .then(() => ready.add(this))
                    .finally(() => inflight.delete(this));
                inflight.set(this, pending);
            }

            await pending;
        }

        return await target.apply(this, args);
    };
}
