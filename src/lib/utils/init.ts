import { KvError_Init_Recursion } from './errors';

interface HasInit {
    init(): Promise<void>;
}

const inflight = new WeakMap<object, Promise<unknown>>();
const ready = new WeakSet();

/**
 * Legacy (TS `experimentalDecorators`) method decorator that lazily runs
 * `this.init()` exactly once on the first decorated call, before invoking
 * the wrapped method body. Concurrent calls share a single in-flight init
 * promise; if init rejects, the next call will retry.
 *
 * Stored as a legacy-style decorator (not stage-3) because istanbul's
 * coverage instrumentation tracks per-method calls correctly with legacy
 * decorators but creates phantom "uncovered" function entries with
 * stage-3 ones.
 */
export function Init(
    _target: HasInit,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
): PropertyDescriptor {
    if (propertyKey === 'init') {
        throw new KvError_Init_Recursion();
    }

    const original = descriptor.value as (this: HasInit, ...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function (this: HasInit, ...args: unknown[]): Promise<unknown> {
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

        return await original.apply(this, args);
    };

    return descriptor;
}
