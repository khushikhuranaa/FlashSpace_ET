import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  server: {
    deps: {
      // never pre-bundle workspace packages; use built dist
      inline: [/@flashspace\/shared/],
    },
  },
});
