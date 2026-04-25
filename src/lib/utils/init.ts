import { KvError_Init } from './errors';

interface HasInit {
    init(): Promise<void>;
}

const inflight = new WeakMap<object, Promise<unknown>>();

const ready = new WeakSet<object>();

export function Init<This extends object, Args extends any[], Return>(
    target: (this: This, ...args: Args) => Promise<Return>,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Return>>,
) {
    if (ctx.name === 'init') {
        throw new KvError_Init('The "init" method cannot be decorated with @Init — that would cause infinite recursion.');
    }

    return async function (this: This, ...args: Args): Promise<Return> {
        if (!ready.has(this)) {
            let pending = inflight.get(this);

            if (!pending) {
                pending = ((this as HasInit).init?.() ?? Promise.resolve())
                    .then(() => ready.add(this))
                    .finally(() => inflight.delete(this));
                inflight.set(this, pending);
            }

            await pending;
        }

        return target.apply(this, args);
    };
}
