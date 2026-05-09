import { defineConfig } from 'wxt'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'

function copyOrtFiles() {
  const require = createRequire(import.meta.url)
  // Resolve via an exported file, then walk up to the package root
  const ortEntry = require.resolve('onnxruntime-web')
  const ortDist = resolve(dirname(ortEntry))
  const destDir = resolve('public/ort')
  mkdirSync(destDir, { recursive: true })

  const files = [
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]

  for (const file of files) {
    cpSync(resolve(ortDist, file), resolve(destDir, file), { force: true })
  }
}

copyOrtFiles()

const ALLOWED_MODES = new Set(['development', 'production'])
const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex !== -1 ? process.argv[modeIndex + 1] : 'production'
if (!ALLOWED_MODES.has(mode)) {
  throw new Error(`Invalid mode "${mode}". Allowed: ${[...ALLOWED_MODES].join(', ')}`)
}

export default defineConfig({
  manifest: {
    name: mode === 'development' ? 'Divinci Local Inference [dev]' : 'Divinci Local Inference',
    description:
      'In-browser Gemma 4 inference via WebGPU for chat.divinci.app — model loads once, stays cached, shared across tabs.',
    permissions: ['offscreen', 'storage'],
    // Keep this list in lockstep with shared/models.ts ALLOWED_WEB_APP_ORIGINS.
    // The bridge enforces the same list at runtime as defense-in-depth.
    externally_connectable: {
      matches: [
        'https://chat.divinci.app/*',
        'https://chat.stage.divinci.app/*',
        'https://chat.dev.divinci.app/*',
        'http://localhost:8080/*',
      ],
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    build: {
      target: 'esnext',
      sourcemap: true,
      minify: false,
    },
  }),
})
