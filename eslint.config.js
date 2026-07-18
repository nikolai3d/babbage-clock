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
      // Agent scratch space. Worktrees under here are full checkouts of this
      // repo, so without this ESLint lints every parallel branch as well as
      // this one — and races their build output, failing on files that vanish
      // mid-run. Invisible in CI, which has no worktrees.
      '.claude/**',
      '.codex/**',
      '.agents/**',
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
    // Everything that runs in Node rather than the browser: the build config
    // and the Playwright layer. Specs are Node code, but the bodies passed to
    // `page.evaluate()` are browser code, so both global sets apply.
    files: ['vite.config.ts', 'e2e/**/*.ts', 'capture/**/*.ts', 'playwright*.config.ts'],
    languageOptions: {
      parserOptions: {
        // These files live in tsconfig.node.json, which the project service
        // would not find on its own — it only looks for `tsconfig.json`.
        projectService: false,
        project: ['./tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
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
    // Build-time Node scripts (`npm run ci` and the deploy workflow run these).
    // Plain ESM JavaScript, outside every tsconfig project, so the type-aware
    // rules have nothing to work from — same situation as eslint.config.js.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Their entire job is to print a report to stdout / the CI step summary.
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
