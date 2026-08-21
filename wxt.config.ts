import { defineConfig } from 'wxt'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { PROD_AUTH0_CLIENT_ID, PROD_AUTH0_CLIENT_ID_UNSET } from './shared/auth-config'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  WEB_ACCESSIBLE_RESOURCES,
  unexposedPageContextRefs,
  unnecessaryExposure,
} from './build/web-accessible'
import { findStagingLeaks } from './build/no-staging-leak'
import { missingOrtBinaries, ortRequirements } from './build/ort-binaries'

function copyOrtFiles() {
  const require = createRequire(import.meta.url)
  // Resolve via an exported file, then walk up to the package root
  const ortEntry = require.resolve('onnxruntime-web')
  const ortDist = resolve(dirname(ortEntry))
  const destDir = resolve('public/ort')
  mkdirSync(destDir, { recursive: true })

  // WebGPU only. The WASM execution-provider binaries (plain + jsep, ~37 MB)
  // are NOT shipped: the sole device:'wasm' model is gated behind `comingSoon`,
  // so nothing can reach them, and the ORT alias they need is reverted — see
  // the guard in this file and the LFM2.5 entry in shared/models.ts.
  const files = [
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]

  for (const file of files) {
    cpSync(resolve(ortDist, file), resolve(destDir, file), { force: true })
  }

  // Drop anything this list no longer names. public/ort is TRACKED, so a
  // removed entry would otherwise linger on disk and keep the build working
  // here while failing on a clean checkout — and it would hide the
  // missingOrtBinaries guard, which can only see what is actually shipped.
  // Pruning turns that into a visible git deletion instead.
  for (const stale of readdirSync(destDir)) {
    if (stale.startsWith('ort-wasm-') && !files.includes(stale)) {
      rmSync(resolve(destDir, stale), { force: true })
    }
  }
}

copyOrtFiles()

const ALLOWED_MODES = new Set(['development', 'production'])
const modeIndex = process.argv.indexOf('--mode')
const mode = modeIndex !== -1 ? process.argv[modeIndex + 1] : 'production'
if (!ALLOWED_MODES.has(mode)) {
  throw new Error(`Invalid mode "${mode}". Allowed: ${[...ALLOWED_MODES].join(', ')}`)
}

// Never let a store-packaging run (`wxt zip`) produce a development build:
// dev mode injects `http://localhost:8080` into externally_connectable and a
// localhost host permission, so any local process binding that port in a
// shipped `.crx` could chrome.runtime.connect and consume the user's GPU.
if (mode === 'development' && process.argv.includes('zip')) {
  throw new Error(
    'Refusing to `zip` a development build (localhost would ship in externally_connectable). ' +
      'Run `pnpm zip` in production mode.',
  )
}

// A production build talks to the PRODUCTION tenant, which needs its own Auth0
// SPA application — an Auth0 application is per-tenant, so staging's client id
// is not merely wrong there, it is unknown to the tenant and /authorize answers
// `unauthorized_client`. Loaded from shared/divinci-account.ts (whose
// `import.meta.env.DEV` is undefined under the config loader, so this reads the
// PRODUCTION branch — exactly the one being shipped).
//
// Fail CLOSED at `zip` rather than at runtime: a store package whose sign-in
// 400s is indistinguishable, from the outside, from a working one until a real
// user clicks the button.
// One documented exception: the FIRST store upload is a chicken-and-egg. The
// Auth0 callback URL is `https://<extension-id>.chromiumapp.org/`, and the
// extension id is assigned BY the Chrome Web Store at draft creation — so the
// Auth0 application cannot be configured until a package has been uploaded, and
// a package cannot be built until Auth0 is configured. `DIVINCI_BOOTSTRAP_DRAFT=1`
// breaks the cycle by allowing exactly one unconfigured build to be uploaded as
// a DRAFT (to mint the id), and it is loud about what it produced.
const isBootstrapDraft = process.env.DIVINCI_BOOTSTRAP_DRAFT === '1'

if (mode !== 'development' && process.argv.includes('zip')) {
  if (PROD_AUTH0_CLIENT_ID === PROD_AUTH0_CLIENT_ID_UNSET && isBootstrapDraft) {
    console.warn(
      '\n⚠️  DIVINCI_BOOTSTRAP_DRAFT=1 — building a package whose SIGN-IN CANNOT WORK.\n' +
        '    Upload it as a DRAFT to mint the extension id, then configure Auth0 and\n' +
        '    rebuild WITHOUT this variable. Do NOT submit this package for review.\n',
    )
  } else if (PROD_AUTH0_CLIENT_ID === PROD_AUTH0_CLIENT_ID_UNSET) {
    throw new Error(
      'Refusing to `zip` a production build: the production Auth0 client id is unset.\n' +
        'Create the SPA application in the divinci-prod tenant, register\n' +
        '`https://<extension-id>.chromiumapp.org/` as an Allowed Callback URL, then set\n' +
        '`PRODUCTION.authClientId` in shared/divinci-account.ts.\n' +
        'For the very first draft upload only, see DIVINCI_BOOTSTRAP_DRAFT above.',
    )
  }
}

// ⛔ A device:'wasm' model cannot work while the ORT alias is reverted.
//
// LFM2.5 needs THREE things together: `device: 'wasm'`, ORT's all-backends
// bundle aliased over `onnxruntime-web/webgpu`, and the plain + jsep WASM
// binaries copied above. All three were verified working on 2026-08-21 (loads,
// then answers a system+user prompt in ~9.9s in the side panel) and then
// deliberately reverted, because the model is gated behind `comingSoon` and the
// alias cost ~3.9 MB of package size plus a WebGPU binary set that turned out
// to be fragile.
//
// Without this guard, un-gating the model is a ONE-LINE change that produces a
// load which never completes and never errors — the exact failure that cost a
// day to diagnose. Fail the build instead, and say what to restore.
{
  const modelsSrc = readFileSync(resolve('shared/models.ts'), 'utf-8')
  const reachableWasmModel = modelsSrc
    .split(/^  '/m)
    .some((entry) => /device:\s*'wasm'/.test(entry) && !/comingSoon:\s*true/.test(entry))
  if (reachableWasmModel) {
    throw new Error(
      "A model declares device:'wasm' and is no longer gated by `comingSoon`, " +
        'but the ONNX Runtime alias it needs is reverted.\n' +
        'Restore all three together (see commit "LFM2.5 runs again"):\n' +
        "  1. vite resolve.alias: 'onnxruntime-web/webgpu' -> ORT's ort.all.bundle.min.mjs\n" +
        "  2. copy ort-wasm-simd-threaded{,.jsep}.{mjs,wasm} in copyOrtFiles()\n" +
        '  3. …and NOT a web_accessible_resources entry: a framed extension\n' +
        '     page loads its own wasm without one (measured — see the\n' +
        '     `web-accessible` e2e project).\n' +
        '  …and re-verify a WebGPU model too — the alias changes which binaries\n' +
        '  the WebGPU path resolves, so it is not a wasm-only change.',
    )
  }
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

// Host permissions, per environment. MUST stay in lockstep with the environment
// chosen in shared/divinci-account.ts — a host the manifest does not grant is a
// silently-failing fetch at runtime, never a build error.
const API_HOSTS =
  mode === 'development'
    ? [
        'https://api.stage.divinci.app',
        'https://api.dev.divinci.app',
        // Auth0 STAGING tenant — the SW fetches /oauth/token here during the
        // PKCE sign-in + refresh. (The /authorize redirect is handled by
        // chrome.identity.launchWebAuthFlow and needs no host permission.)
        'https://divinci-staging.us.auth0.com',
        'http://localhost:9080',
      ]
    : [
        'https://api.divinci.app',
        // Auth0 PRODUCTION tenant.
        'https://divinci-prod.us.auth0.com',
      ]

// Web apps allowed to open a runtime port to us. Keep in lockstep with
// shared/models.ts ALLOWED_WEB_APP_ORIGINS — the bridge re-checks the origin at
// port-acceptance time as defense in depth.
//
// A PRODUCTION build allowlists the production web app ONLY. The staging/dev
// origins are a testing affordance, and every extra origin in a published
// package is both attack surface and Chrome Web Store review surface; internal
// testing against staging uses the dev build (loaded unpacked), which is what
// it is for. localhost:8080 stays dev-only: in a published .crx ANY process
// binding :8080 (Tomcat, Jenkins, random Express boilerplate) could
// chrome.runtime.connect to us and consume the user's GPU.
const WEB_APP_ORIGINS =
  mode === 'development'
    ? [
        // Dev builds are a SUPERSET — see shared/models.ts.
        'https://chat.divinci.app/*',
        'https://chat.stage.divinci.app/*',
        'https://chat.dev.divinci.app/*',
        'http://localhost:8080/*',
      ]
    : ['https://chat.divinci.app/*']

export default defineConfig({
  manifest: {
    name: mode === 'development' ? 'Divinci Local Inference [dev]' : 'Divinci Local Inference',
    description:
      'In-browser Gemma 4 inference via WebGPU for chat.divinci.app — model loads once, stays cached, shared across tabs.',
    // `key` is DEV-ONLY. The Chrome Web Store REJECTS a new item whose manifest
    // carries one — the dashboard answers `key field is not allowed in
    // manifest.` and the upload fails outright (it is not stripped for you).
    // The store mints its own id at draft creation; adopt THAT key here later
    // if you want the unpacked id to match the published one.
    ...(mode === 'development' ? { key: MANIFEST_PUBLIC_KEY } : {}),
    // unlimitedStorage: conversation history lives in chrome.storage.local
    // (extension-global, reachable from the content script + SW; a content
    // script's IndexedDB is the host page's origin, which would silo history
    // per website). Removes the storage quota for long histories.
    permissions: ['offscreen', 'storage', 'identity', 'unlimitedStorage', 'sidePanel'],
    host_permissions: API_HOSTS.map((h) => `${h}/*`),
    // Keep this list in lockstep with shared/models.ts ALLOWED_WEB_APP_ORIGINS.
    // The bridge enforces the same list at runtime as defense-in-depth.
    // localhost:8080 is intentionally dev-only. In a published .crx ANY
    // process that binds :8080 (Tomcat, Jenkins, random Express boilerplate)
    // could chrome.runtime.connect to us and consume the user's GPU. Dev
    // mode keeps the entry for `pnpm start:dev` against the local web app.
    externally_connectable: {
      matches: WEB_APP_ORIGINS,
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    // The in-page panel (content script) renders the Divinci robot in its empty
    // state; an <img src="chrome-extension://…/divinci-robot.png"> in page DOM
    // needs the asset declared web-accessible for every site the panel runs on.
    // See build/web-accessible.ts for the list and WHY it is not hand-maintained.
    web_accessible_resources: [
      {
        resources: WEB_ACCESSIBLE_RESOURCES,
        matches: ['<all_urls>'],
      },
    ],
    // Toolbar icon opens the popup management UI. WXT auto-detects
    // entrypoints/popup/index.html and emits popup.html in the build,
    // so the path here matches the WXT build output (not the source path).
    action: {
      default_title: 'Divinci Local Inference',
      default_popup: 'popup.html',
    },
    // Browser side-panel dock. WXT auto-detects entrypoints/panel/index.html and
    // emits panel.html. Opened on demand (Phase 4 hamburger "Dock" toggle →
    // chrome.sidePanel.open) or via Chrome's own side-panel picker. Not set to
    // open-on-action-click — the toolbar icon keeps opening the popup.
    side_panel: {
      default_path: 'panel.html',
    },
  },
  hooks: {
    // Recompute the real import graph of the framed iframes from the build
    // output and fail the build if anything reachable is not web-accessible.
    // Runs on EVERY build, including the one inside `wxt zip`, so a store
    // package can never ship a blank iframe. The failure mode this replaces is
    // silent: the browser blocks the sub-resource and nothing is logged that
    // points at the manifest.
    'build:done': (wxt: { config: { outDir: string } }) => {
      // What the PAGE loads is what the manifest governs — measured, see
      // build/web-accessible.ts. Content scripts are the bridge, so their
      // getURL() paths are the whole surface.
      const fsApi = { existsSync, readFileSync, readdirSync }
      const joinPath = (...parts: string[]) => parts.join('/')

      const unexposed = unexposedPageContextRefs(wxt.config.outDir, fsApi, joinPath)
      if (unexposed.length > 0) {
        throw new Error(
          'A content script hands the page a path the manifest does not ' +
            'expose, so the page cannot load it — silently, with no error ' +
            'attributable to the manifest:\n' +
            unexposed.map((r) => `  - ${r.path} (from ${r.script})`).join('\n') +
            '\nAdd it to WEB_ACCESSIBLE_RESOURCES in build/web-accessible.ts.',
        )
      }

      // Every ORT build we inline must find its binaries in ort/. See
      // build/ort-binaries.ts — this is a 404 with no attributable error.
      const ortDist = resolve(dirname(createRequire(import.meta.url).resolve('onnxruntime-web')))
      const missingOrt = missingOrtBinaries(wxt.config.outDir, ortDist, fsApi, joinPath)
      if (missingOrt.length > 0) {
        throw new Error(
          'A bundled ONNX Runtime build asks for wasm binaries that are not ' +
            'in ort/, so it will 404 at runtime:\n' +
            missingOrt
              .map((m) => `  - ${m.file} (${m.bundle}, inlined by ${m.usedBy.join(', ')})`)
              .join('\n') +
            '\nEither copy it in copyOrtFiles(), or change the import so this ' +
            'code uses the ORT build whose binaries are already shipped — ' +
            'each variant is ~24 MB, so sharing one is usually right.\n' +
            'Currently required: ' +
            JSON.stringify(
              ortRequirements(wxt.config.outDir, ortDist, fsApi, joinPath).map((r) => ({
                [r.bundle]: r.requires,
              })),
            ),
        )
      }

      const surplus = unnecessaryExposure(wxt.config.outDir, fsApi, joinPath)
      if (surplus.length > 0) {
        throw new Error(
          'web_accessible_resources exposes patterns to <all_urls> that no ' +
            'page-context path needs:\n' +
            surplus.map((p) => `  - ${p}`).join('\n') +
            '\nRemove them. A framed extension page loads its own ' +
            'sub-resources without an entry (e2e project `web-accessible` ' +
            'measures this), so entries for chunks or wasm are surface for ' +
            'nothing. If a page-context caller was just added, this is ' +
            'telling you the guard cannot see it.',
        )
      }

      // A production bundle must not carry staging/dev hostnames. The manifest
      // being clean is not enough — the leak that shipped was inside
      // background.js, invisible to every other check.
      if (mode !== 'development') {
        const leaks = findStagingLeaks(
          wxt.config.outDir,
          { readdirSync, readFileSync },
          (...parts: string[]) => parts.join('/'),
        )
        if (leaks.length > 0) {
          throw new Error(
            'Production build leaks non-production hostnames:\n' +
              leaks.map((l) => `  - ${l.file}: ${l.needle}`).join('\n') +
              '\nA dead branch survived tree-shaking — check that the guard on ' +
              'it uses the bare `import.meta.env.DEV`, which Vite can replace.',
          )
        }
      }
    },
  },
  vite: () => ({
    build: {
      target: 'esnext',
      // Ship neither source maps nor readable source in a production build:
      // both leak the full application source into the store `.zip` and are a
      // common review flag. Dev builds keep them for debuggability.
      sourcemap: mode === 'development',
      minify: mode === 'development' ? false : 'esbuild',
    },
  }),
})
