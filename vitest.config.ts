import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: [
      {
        find: /^cambrian$/,
        replacement: resolve(__dirname, 'tests/fixtures/cambrian.ts'),
      },
    ],
  },
});
