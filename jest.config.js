/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/**/*.test.ts'],
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
            tsconfig: {
                module: 'esnext',
                target: 'es2022',
                moduleResolution: 'bundler',
                // Match the project's tsconfig — legacy decorators play
                // nicely with istanbul's instrumentation, whereas stage-3
                // decorators leave phantom uncovered function entries.
                experimentalDecorators: true,
            },
        }],
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    // Coverage is opt-in via `npm run test:coverage` (or `jest --coverage`).
    // The HTML report lands at .coverage/lcov-report/index.html; open that
    // file in a browser to inspect line/branch coverage interactively.
    coverageDirectory: '.coverage',
    coverageReporters: ['html', 'text', 'text-summary', 'lcov', 'json', 'json-summary'],
    collectCoverageFrom: [
        'src/lib/**/*.ts',
        '!src/lib/**/*.test.ts',
    ],
};
