import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    {
        ignores: ['dist/', 'node_modules/', 'data/', 'coverage/'],
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
        },
    },

    // jest.config.js is CommonJS; tell ESLint about its globals and disable
    // type-aware rules (it isn't part of the TS project).
    {
        files: ['jest.config.js', '**/*.cjs'],
        ...tseslint.configs.disableTypeChecked,
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                module: 'readonly',
                require: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
            },
        },
    },

    // The eslint config itself isn't covered by tsconfig either.
    {
        files: ['eslint.config.mjs'],
        ...tseslint.configs.disableTypeChecked,
    },
);
