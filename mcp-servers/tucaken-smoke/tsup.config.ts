import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  bundle: true,
  clean: true,
  external: ['pg'],
  banner: { js: '#!/usr/bin/env node' },
});
