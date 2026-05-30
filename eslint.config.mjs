// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/cdk.out/**',
      'applications/shared/dist/**',
      'applications/*/dist/**',
      // infra/ has its own eslint config (with jest plugin + import/order rules);
      // root lints applications/** + bin/** only to avoid double-linting and
      // cross-config "unknown rule" errors on per-file disable comments.
      'infra/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
    rules: {
      '@typescript-eslint/no-explicit-any':         'error',
      '@typescript-eslint/no-unused-vars':          ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-unused-vars':                              'off',
    },
  },
  // CommonJS config files (jest, etc.) legitimately use require() and are not ESM.
  {
    files: ['**/*.cjs', '**/jest.config.js', '**/jest.config.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
