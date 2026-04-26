/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
/**
 * Unified test API that works under both `npm test` (jest) and
 * `bun test`. Test files import `describe / it / expect / jest / mock /
 * mockModule / IS_BUN` from this module instead of `@jest/globals`,
 * and the right runner's implementation is picked at runtime.
 *
 * Detection: Bun defines a global `Bun` object that jest doesn't.
 *
 * Type-wise, every export is annotated with the type from
 * `@jest/globals` (a type-only import — never resolves at runtime under
 * bun). Bun's `bun:test` shapes are jest-compatible enough that the
 * cast is sound for our usage; if bun ever drifts, the failing test
 * surface tells us where.
 *
 * Caveats:
 * - Bun's crypto module is missing some ciphers Node ships (e.g.
 *   `aes-256-xts`); test suites that need them should use
 *   `describe.skip` / `it.skip` under `IS_BUN`.
 * - `jest.unstable_mockModule` returns a Promise under jest and
 *   undefined under bun; both register before the next dynamic
 *   `import()`, which is the contract callers actually rely on.
 */

import type * as JG from '@jest/globals';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

interface RawTestApi {
    describe: any;
    it: any;
    expect: any;
    beforeEach: any;
    afterEach: any;
    beforeAll: any;
    afterAll: any;
    jest: any;
    mock: any;
    spyOn: any;
    mockModule: any;
}

let raw: RawTestApi;
if (isBun) {
    // @ts-expect-error 'bun:test' only resolves under Bun's runtime.
    const m = await import('bun:test');
    const mockModule = (name: string, factory: () => unknown): unknown => m.mock.module(name, factory);
    raw = {
        describe: m.describe,
        it: m.it,
        expect: m.expect,
        beforeEach: m.beforeEach,
        afterEach: m.afterEach,
        beforeAll: m.beforeAll,
        afterAll: m.afterAll,
        jest: {
            fn: m.mock,
            spyOn: m.spyOn,
            unstable_mockModule: mockModule,
        },
        mock: m.mock,
        spyOn: m.spyOn,
        mockModule,
    };
} else {
    const m = await import('@jest/globals');
    raw = {
        describe: m.describe,
        it: m.it,
        expect: m.expect,
        beforeEach: m.beforeEach,
        afterEach: m.afterEach,
        beforeAll: m.beforeAll,
        afterAll: m.afterAll,
        jest: m.jest,
        mock: m.jest.fn.bind(m.jest),
        spyOn: m.jest.spyOn.bind(m.jest),
        mockModule: (name: string, factory: () => unknown) => m.jest.unstable_mockModule(name, factory),
    };
}

export const IS_BUN: boolean = isBun;
export const describe = raw.describe as typeof JG.describe;
export const it = raw.it as typeof JG.it;
export const expect = raw.expect as typeof JG.expect;
export const beforeEach = raw.beforeEach as typeof JG.beforeEach;
export const afterEach = raw.afterEach as typeof JG.afterEach;
export const beforeAll = raw.beforeAll as typeof JG.beforeAll;
export const afterAll = raw.afterAll as typeof JG.afterAll;
export const jest = raw.jest as typeof JG.jest;
/** Direct equivalent of `jest.fn` for bun-style call sites. */
export const mock = raw.mock as typeof JG.jest.fn;
/** Direct equivalent of `jest.spyOn`. */
export const spyOn = raw.spyOn as typeof JG.jest.spyOn;
/** Direct equivalent of `jest.unstable_mockModule`. */
export const mockModule = raw.mockModule as (name: string, factory: () => unknown) => unknown;
