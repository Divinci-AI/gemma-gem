import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts'],
    // e2e/ uses Playwright (`*.spec.ts`), not vitest. Keep them out of
    // the unit-test pool so `pnpm test` doesn't try to run them with
    // the wrong runner.
    exclude: ['node_modules', '.output', '.wxt', 'e2e/**'],
  },
})
