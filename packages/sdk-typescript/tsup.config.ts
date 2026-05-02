import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // Don't bundle peer / runtime deps — emit imports as-is so consumers can
  // resolve their own copies (relevant for @driftstack/api-types when this
  // package is published).
  external: ['@driftstack/api-types'],
});
