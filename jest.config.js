/**
 * Jest config — ts-jest ESM preset because the project's `module` is `es2022`
 * and ESM imports use bare `.ts` paths without explicit extensions.
 *
 * Run with `node --experimental-vm-modules` (set in the npm scripts) so
 * ESM modules can be loaded into the test VM and `jest.unstable_mockModule`
 * works for the few places that need to intercept dynamic imports
 * (e.g. `fs/promises` in `kv-block-device-fs.test.ts`).
 *
 * Coverage thresholds gate at 100% so CI / pre-commit fail loudly if
 * coverage regresses.
 */
/** @type {import('jest').Config} */
export default {
    preset: 'ts-jest/presets/default-esm',
    extensionsToTreatAsEsm: ['.ts'],
    testEnvironment: 'node',
    moduleFileExtensions: ['ts', 'js', 'json'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true }],
    },
    testMatch: ['<rootDir>/src/**/*.test.ts'],
    coverageDirectory: '.coverage',
    // istanbul (jest's default) gives function-level coverage that mirrors
    // ts-jest's transformed sources; v8 over-counts barrel re-exports and
    // type-only positions that aren't real executable lines.
    coverageProvider: 'babel',
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.test.ts',
        '!src/mocks/**',
        '!src/examples/**',
        '!src/acceptance/**',
        '!src/**/index.ts',
    ],
    coverageReporters: ['text', 'html', 'json-summary', 'lcov'],
    coverageThreshold: {
        global: {
            statements: 100,
            branches: 100,
            functions: 100,
            lines: 100,
        },
    },
};
