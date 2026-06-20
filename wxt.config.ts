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

// Pinned public key for a stable extension ID across every machine that
// loads this unpacked. Derives the deterministic ID
// `laeebjagghfeepomjhbfohefghonemeo` so the web app's extension-capabilities
// probe can hardcode that one value instead of using a localStorage dev
// override per developer.
//
// The private half lives in this repo's sibling
// `divinci-ai/server/private-keys/extensions/divinci-local-inference/private.pem`
// — committed to the private-keys submodule, not to this public-ish fork.
// You only need the private key to sign a `.crx` for sideload; loading
// unpacked doesn't require it.
const MANIFEST_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsGNVAMfM6OPVfbS/0QGMRbKHv04SmYg5wHhpJZRVXh/6jbEKP4Rx71nI11fisIzGkbjYSDeUlZoWQrcbP9sJmoYAt32b/Ceodix4cYxUHk+slhYHJRojfu+XDUAms3lZDUpJgC5aD6nrKDWq0fZ0npT4tfxsgtDygrjEexDlhBx2y07gUULkuAqPDuqHwl4m7oZE5QXCvRGuMlZVenw32YejpXlZJrAKdcibz2R4X8eCEhNkQDWlXeuLG0kYijP44Pq7LbKh5M3ucad9WFNBbDVdqeone9COO91zcv8asvQCfyUoYM3EQVdg7HepnSrZmnKnOwak4ugeZerFP+EqjwIDAQAB'

const API_HOSTS = [
  'https://api.divinci.app',
  'https://api.stage.divinci.app',
  'https://api.dev.divinci.app',
  // Auth0 staging tenant — the SW fetches /oauth/token here during the PKCE
  // sign-in + refresh. (The /authorize redirect is handled by
  // chrome.identity.launchWebAuthFlow and needs no host permission.)
  'https://divinci-staging.us.auth0.com',
  ...(mode === 'development' ? ['http://localhost:9080'] : []),
]

export default defineConfig({
  manifest: {
    name: mode === 'development' ? 'Divinci Local Inference [dev]' : 'Divinci Local Inference',
    description:
      'In-browser Gemma 4 inference via WebGPU for chat.divinci.app — model loads once, stays cached, shared across tabs.',
    key: MANIFEST_PUBLIC_KEY,
    permissions: ['offscreen', 'storage', 'identity'],
    host_permissions: API_HOSTS.map((h) => `${h}/*`),
    // Keep this list in lockstep with shared/models.ts ALLOWED_WEB_APP_ORIGINS.
    // The bridge enforces the same list at runtime as defense-in-depth.
    // localhost:8080 is intentionally dev-only. In a published .crx ANY
    // process that binds :8080 (Tomcat, Jenkins, random Express boilerplate)
    // could chrome.runtime.connect to us and consume the user's GPU. Dev
    // mode keeps the entry for `pnpm start:dev` against the local web app.
    externally_connectable: {
      matches: [
        'https://chat.divinci.app/*',
        'https://chat.stage.divinci.app/*',
        'https://chat.dev.divinci.app/*',
        ...(mode === 'development' ? ['http://localhost:8080/*'] : []),
      ],
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // Toolbar icon opens the popup management UI. WXT auto-detects
    // entrypoints/popup/index.html and emits popup.html in the build,
    // so the path here matches the WXT build output (not the source path).
    action: {
      default_title: 'Divinci Local Inference',
      default_popup: 'popup.html',
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
