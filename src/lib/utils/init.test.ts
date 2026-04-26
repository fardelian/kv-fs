import { describe, it, expect, jest } from '@jest/globals';
import { Init } from './init';
import { KvError_Init_Recursion } from './errors';

describe('@Init decorator', () => {
    describe('init-recursion guard', () => {
        it('throws KvError_Init_Recursion when applied to a method named "init"', () => {
            // Wrapping the class declaration in a function: the decorator
            // throws synchronously while the class body is being evaluated.
            expect(() => {
                class Bad {
                    @Init
                    public async init(): Promise<void> { await Promise.resolve(); }
                }
                // Reference Bad so TS doesn't tree-shake it; the throw should
                // fire before this line is reached.
                void Bad;
            }).toThrow(KvError_Init_Recursion);
        });

        it('does not throw when applied to a method with any other name', () => {
            expect(() => {
                class Good {
                    public async init(): Promise<void> { await Promise.resolve(); }

                    @Init
                    public async someOtherMethod(): Promise<void> { await Promise.resolve(); }
                }
                void Good;
            }).not.toThrow();
        });
    });

    describe('lazy init behaviour', () => {
        it('runs init() once on the first decorated call and shares it across concurrent callers', async () => {
            const initFn = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

            class C {
                public init = initFn;

                @Init
                public async work(label: string): Promise<string> {
                    return `did ${label}`;
                }
            }

            const c = new C();
            const [a, b] = await Promise.all([c.work('a'), c.work('b')]);

            expect(a).toBe('did a');
            expect(b).toBe('did b');
            expect(initFn).toHaveBeenCalledTimes(1);

            // Subsequent calls must not re-init.
            await c.work('c');
            expect(initFn).toHaveBeenCalledTimes(1);
        });

        it('re-runs init() if the previous attempt rejected', async () => {
            const initFn = jest.fn<() => Promise<void>>();
            initFn.mockRejectedValueOnce(new Error('first init failed'));
            initFn.mockResolvedValueOnce(undefined);

            class C {
                public init = initFn;

                @Init
                public async work(): Promise<number> {
                    return 42;
                }
            }

            const c = new C();
            await expect(c.work()).rejects.toThrow('first init failed');
            await expect(c.work()).resolves.toBe(42);
            expect(initFn).toHaveBeenCalledTimes(2);
        });
    });
});
