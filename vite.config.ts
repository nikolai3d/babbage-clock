import { defineConfig } from 'vitest/config';

/**
 * Public base path for the built site.
 *
 * The default is relative (`./`), which is what makes `npm run preview`, the
 * e2e container and any root-hosted deploy (Netlify, Vercel, a plain static
 * server) all work without configuration.
 *
 * GitHub Pages serves this repository as a *project* page under
 * `/babbage-clock/`, so the deploy workflow sets `VITE_BASE_PATH=/babbage-clock/`
 * and every emitted URL becomes absolute under that prefix. Moving to a
 * root-hosted provider is then a matter of dropping the variable, not editing
 * this file.
 *
 * Caveat worth repeating (see docs/deploy.md): Vite only rewrites URLs it can
 * see — module imports, `new URL(..., import.meta.url)`, CSS `url()` and the
 * HTML entry. A hand-written `fetch('/assets/x.hdr')` is invisible to it and
 * 404s on a project page. Use `import.meta.env.BASE_URL` for runtime fetches;
 * `scripts/check-base-path.mjs` fails the build on the common mistakes.
 */
const base = process.env.VITE_BASE_PATH ?? './';

export default defineConfig({
  base,
  // HDR panoramas are not in Vite's default asset list. Declaring them here is
  // what lets `assets/ibl/*/…` be imported for its URL, emitted with a content
  // hash under `base`, and — crucially — left alone rather than parsed as text.
  // The moods reach them through `import.meta.glob(..., { query: '?url' })`,
  // which Vite rewrites, so they are base-path correct on a project page.
  assetsInclude: ['**/*.hdr', '**/*.exr', '**/*.ktx2'],
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // The render layer is a dynamic import behind a WebGL2 probe (see
    // main.ts), so three.js is already out of the entry chunk. Splitting it
    // from the app's own render code as well means a rendering change does not
    // re-download the ~500 kB of three.js that did not change — the vendor
    // chunk's hash is stable until the three version moves.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three';
          return undefined;
        },
      },
    },
    // With three.js in its own chunk nothing should come near this; the limit
    // exists so the next accidental import into the entry chunk is loud.
    chunkSizeWarningLimit: 600,
  },
  test: {
    // Unit tests are deliberately environment-free: time math and scene
    // definitions must not require a DOM or a WebGL context. Rendering code is
    // covered by the e2e/screenshot harness added in a later bead.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
