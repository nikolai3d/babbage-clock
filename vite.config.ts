import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // three.js alone is ~500 kB minified; the default warning threshold is
    // noise here. Revisit if the app bundle grows independently of three.
    chunkSizeWarningLimit: 900,
  },
  test: {
    // Unit tests are deliberately environment-free: time math and scene
    // definitions must not require a DOM or a WebGL context. Rendering code is
    // covered by the e2e/screenshot harness added in a later bead.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
