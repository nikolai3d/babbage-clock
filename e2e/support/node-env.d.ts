/**
 * The handful of Node globals the Playwright layer uses.
 *
 * Why not `@types/node`? Installing it changes the *whole* program's typing,
 * not just this directory: `vitest` carries a `/// <reference types="node" />`,
 * so once the package resolves, `setTimeout` in `src/` starts returning Node's
 * `Timeout` instead of the DOM's `number`. Application code would then be
 * type-checked against a platform it never runs on, and existing code that
 * relies on `ReturnType<typeof setInterval>` breaks.
 *
 * The e2e layer's needs are small and stable, so declaring them here keeps the
 * browser and Node type worlds properly separated. Add to this list only what
 * is actually used — if it grows much beyond this, revisit the decision and
 * split the build into TypeScript project references instead.
 */

declare const process: {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  /** Used to give each concurrent run its own preview port. See `env.ts`. */
  readonly pid: number;
  cwd(): string;
};
