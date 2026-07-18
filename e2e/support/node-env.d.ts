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

/**
 * Just enough of Node's `Buffer` for what Playwright hands back.
 *
 * `page.screenshot()` is typed as returning one, so without this the whole
 * expression resolves to `error` and the type-checked lint rules reject every
 * use of it. Only the members the specs actually touch are declared.
 */
interface Buffer extends Uint8Array {
  equals(other: Uint8Array): boolean;
}

declare const process: {
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  /** Used to give each concurrent run its own preview port. See `env.ts`. */
  readonly pid: number;
  cwd(): string;
};

/**
 * Just enough of pngjs for the contrast spec. Its published typings live in
 * `@types/pngjs`, which depends on `@types/node` — installing that re-types
 * `setTimeout` across `src/` (see the `process` note above), so the four
 * symbols the spec uses are declared here instead.
 */
declare module 'pngjs' {
  export class PNG {
    static sync: { read(buffer: Uint8Array): PNG };
    width: number;
    height: number;
    /** RGBA, row-major, 4 bytes per pixel. */
    data: Uint8Array;
  }
}
