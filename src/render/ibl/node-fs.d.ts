/**
 * The slice of `node:fs` the IBL content tests need, declared locally.
 *
 * Why not `@types/node`: those types are global, and pulling them in changes
 * what `setTimeout` returns for the *whole* project — `time/trueTime.ts` types
 * its `Scheduler` as `ReturnType<typeof setTimeout>`, which is a `number` in a
 * browser and a `Timeout` object under Node. This is a browser app, so the app's
 * type surface should stay browser-shaped; only `manifest.test.ts` needs to
 * reach the disk, and only to prove the shipped HDRIs are really there and
 * really HDRIs.
 *
 * Deliberately narrow: if a test needs something not declared here, that is a
 * prompt to ask whether the test belongs in a Node environment at all.
 */
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readFileSync(path: string | URL): {
    readonly byteLength: number;
    subarray(start: number, end: number): { toString(encoding: 'ascii'): string };
  };
  export function readdirSync(path: string | URL): string[];
  export function statSync(path: string | URL): {
    isDirectory(): boolean;
    readonly size: number;
  };
}
