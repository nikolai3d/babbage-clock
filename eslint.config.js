import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.beads/**',
      // Playwright output: baselines, videos, traces and diffs.
      'e2e/__screenshots__/**',
      'test-results/**',
      'playwright-report/**',
      'artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['vite.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Playwright specs and configs run in Node, but the code inside
    // `page.evaluate()` is browser code, so both global sets apply.
    files: ['e2e/**/*.ts', 'capture/**/*.ts', 'playwright*.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Specs legitimately log which GL backend served the run and where the
      // demo video landed; that output is the point of running them.
      'no-console': 'off',
    },
  },
  {
    // The flat config itself is plain JS and lives outside the tsconfig
    // project, so type-aware rules cannot run on it.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  prettier,
);
