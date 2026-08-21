import { defineConfig } from '@playwright/test'

/**
 * Playwright config for the Divinci Local Inference extension smoke tests.
 *
 * The smoke project verifies the extension loads, the externally_connectable
 * config is correct, the stable manifest key produces the expected ID, and
 * the divinci:ping endpoint responds. No model load — fast (<30s) and
 * runnable on any dev box without WebGPU.
 *
 * The full-inference project is gated behind RUN_REAL_INFERENCE=1 because
 * it downloads the 2.9 GB model weights and requires a WebGPU-capable
 * GPU. Intended for local pre-release validation, not CI.
 */
export default defineConfig({
  testDir: '.',
  // Extensions need a real Chromium with a display. Headed by default;
  // CI runners must provide Xvfb (or use headless: 'new' which works
  // for MV3 service workers in Chromium ≥120).
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  timeout: 60_000,
  projects: [
    {
      name: 'smoke',
      testMatch: /extension-smoke\.spec\.ts$/,
    },
    {
      // Open programmatic API (window.divinci on any origin). No model load.
      name: 'open-api',
      testMatch: /extension-open-api\.spec\.ts$/,
    },
    {
      // Manifest question only: does web_accessible_resources gate a fetch()
      // from a framed extension page? No model load.
      name: 'web-accessible',
      testMatch: /extension-web-accessible\.spec\.ts$/,
    },
    {
      name: 'full-inference',
      testMatch: /extension-inference\.spec\.ts$/,
      // Default: skipped. Opt in with RUN_REAL_INFERENCE=1.
      grep: process.env.RUN_REAL_INFERENCE === '1' ? /.*/ : /__never_match__/,
      timeout: 600_000, // 10 min — accounts for first-time HF download
    },
  ],
})
