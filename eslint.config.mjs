import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    {
        // `scripts/` holds standalone Node helpers that are run by
        // hand (e.g. `node scripts/generate-encryption-vectors.mjs`)
        // and aren't part of the project's TS compile graph; lint
        // would need a separate Node-globals config to handle them
        // and there's no real benefit to linting throwaway helpers.
        ignores: ['dist/', 'node_modules/', 'data/', '.coverage/', 'coverage/', 'scripts/'],
    },

    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,

    // Type-aware rules need to know which tsconfig drives type info.
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },

    // Uniform style: 4-space indent, single quotes, always-semicolons,
    // trailing commas in multi-line literals, eol-at-eof, no-trailing-whitespace.
    stylistic.configs.customize({
        flat: true,
        indent: 4,
        quotes: 'single',
        semi: true,
        commaDangle: 'always-multiline',
        arrowParens: true,
        braceStyle: '1tbs',
    }),

    {
        files: ['**/*.ts'],
        rules: {
            // Numbers in template literals are idiomatic in error messages.
            '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],

            // The @Init decorator guarantees init has run before any decorated
            // method body executes, so `this.key!` etc. are TS-can't-see-this
            // invariants, not unsafe assumptions. `path.pop()!` after split is
            // similarly known-safe in context.
            '@typescript-eslint/no-non-null-assertion': 'off',

            // Wrapping callback APIs in `new Promise(...)` legitimately yields
            // an async function without an explicit await.
            '@typescript-eslint/require-await': 'off',

            // Always `return await` when returning a Promise — keeps the
            // current function on the stack trace and inside the right
            // try/catch frame.
            '@typescript-eslint/return-await': ['error', 'always'],

            // Honour the leading-underscore convention for "this param
            // exists for the contract but I'm not using it" — the
            // strict preset's default flags `_param` unless the rule is
            // restated with the ignore patterns. Common case here: FUSE
            // / abstract-class signatures with kept-but-unused args.
            '@typescript-eslint/no-unused-vars': ['error', {
                args: 'all',
                argsIgnorePattern: '^_',
                caughtErrors: 'all',
                caughtErrorsIgnorePattern: '^_',
                destructuredArrayIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],
        },
    },

    // The eslint config itself isn't covered by tsconfig either.
    {
        files: ['eslint.config.mjs'],
        ...tseslint.configs.disableTypeChecked,
    },

    // Test files: bun-types' matcher signatures aren't always typed as
    // Promises even when they're awaitable, and `mock.module(...)` is a
    // fire-and-forget call that returns undefined. Drop the rules that
    // would otherwise flag the standard test patterns.
    {
        files: ['**/*.test.ts', 'src/mocks/**/*.ts'],
        rules: {
            '@typescript-eslint/await-thenable': 'off',
            '@typescript-eslint/no-confusing-void-expression': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
        },
    },
);
