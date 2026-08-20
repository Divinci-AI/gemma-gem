/**
 * The manifest and the runtime config are two halves of one decision, and
 * nothing in the type system ties them together. A host that appears in
 * shared/divinci-account.ts but NOT in wxt.config.ts's host_permissions is a
 * fetch that fails at runtime in a shipped extension — never a build error.
 * An origin in externally_connectable but not in ALLOWED_WEB_APP_ORIGINS is a
 * port accepted without the defense-in-depth re-check.
 *
 * These tests read wxt.config.ts as TEXT on purpose: importing it would run the
 * config (which copies ORT files and reads process.argv), and the point is to
 * assert what a READER of the manifest source sees, including the guards.
 *
 * They also cover the PRODUCTION branch, which no other test reaches — vitest
 * sets `import.meta.env.DEV = true`, so every other suite in this repo
 * exercises STAGING only.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROD_AUTH0_CLIENT_ID_UNSET } from './divinci-account'
import { ALLOWED_WEB_APP_ORIGINS } from './models'
import { WEB_ACCESSIBLE_RESOURCES, isMatched } from '../build/web-accessible'

const config = readFileSync(resolve(__dirname, '../wxt.config.ts'), 'utf-8')
const accountSrc = readFileSync(resolve(__dirname, 'divinci-account.ts'), 'utf-8')

/** Pull a string field out of one of the environment literals, by source text. */
function envField(objectName: 'PRODUCTION' | 'STAGING', field: string): string {
  const start = accountSrc.indexOf(`const ${objectName}: DivinciEnvironment = {`)
  if (start === -1) throw new Error(`no ${objectName} literal in divinci-account.ts`)
  const body = accountSrc.slice(start, accountSrc.indexOf('}', start))
  const m = new RegExp(`${field}:\\s*'([^']*)'`).exec(body)
  if (!m) {
    const ref = new RegExp(`${field}:\\s*([A-Za-z_$][A-Za-z0-9_$]*)`).exec(body)
    if (ref) return ref[1]
    throw new Error(`no ${field} in ${objectName}`)
  }
  return m[1]
}
const PRODUCTION = {
  authDomain: envField('PRODUCTION', 'authDomain'),
  authClientId: envField('PRODUCTION', 'authClientId'),
  authAudience: envField('PRODUCTION', 'authAudience'),
  apiBase: envField('PRODUCTION', 'apiBase'),
  embedBase: envField('PRODUCTION', 'embedBase'),
}
const STAGING = {
  authDomain: envField('STAGING', 'authDomain'),
  authClientId: envField('STAGING', 'authClientId'),
}
/**
 * Comments in this file legitimately NAME the hosts they exclude ("localhost
 * stays dev-only"), so a bare substring assertion over the raw source matches
 * the prose that explains the rule and fails the very config that follows it.
 * Assert against code only.
 */
const codeOnly = (src: string) =>
  src
    // Block comments first, then whole-line `//` comments. Deliberately NOT a
    // bare /\/\/.*/ — that eats the `//` in every `https://` URL and turns the
    // assertion into one that can never pass.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
/** The `mode !== 'development'` arm of a ternary — i.e. what ships. */
const productionArm = config.slice(config.indexOf('const API_HOSTS ='))

describe('production environment config', () => {
  it('points every endpoint at production — no stage/dev/localhost leakage', () => {
    for (const [field, value] of Object.entries(PRODUCTION)) {
      if (field === 'authClientId') continue // sentinel until Auth0 is configured
      expect(value, `PRODUCTION.${field}`).not.toMatch(/stage|\bdev\b|localhost/)
    }
    expect(PRODUCTION.apiBase).toBe('https://api.divinci.app')
    expect(PRODUCTION.authDomain).toBe('divinci-prod.us.auth0.com')
    expect(PRODUCTION.authAudience).toBe('chat.divinci.app:8080')
  })

  it('uses a DIFFERENT Auth0 tenant and client id from staging', () => {
    // An Auth0 application is per-tenant. Reusing staging's client id against
    // the production tenant fails `unauthorized_client` at /authorize.
    expect(PRODUCTION.authDomain).not.toBe(STAGING.authDomain)
    expect(PRODUCTION.authClientId).not.toBe(STAGING.authClientId)
  })
})

describe('manifest ↔ runtime lockstep', () => {
  it('grants host permission for the production API base and Auth0 tenant', () => {
    const shipped = productionArm.slice(0, productionArm.indexOf('const WEB_APP_ORIGINS'))
    expect(shipped).toContain(`'${PRODUCTION.apiBase}'`)
    expect(shipped).toContain(`'https://${PRODUCTION.authDomain}'`)
  })

  it('ships NO staging/dev/localhost host permission in a production build', () => {
    const prodHosts = codeOnly(
      productionArm.slice(
        productionArm.indexOf(': ['),
        productionArm.indexOf('const WEB_APP_ORIGINS'),
      ),
    )
    expect(prodHosts).toContain('https://api.divinci.app')
    expect(prodHosts).not.toMatch(/api\.stage|api\.dev|localhost/)
  })

  it('allowlists exactly one web-app origin in a production build', () => {
    const origins = codeOnly(productionArm.slice(productionArm.indexOf('const WEB_APP_ORIGINS')))
    const prodBranch = origins.slice(origins.indexOf(": ['https"))
    expect(prodBranch).toContain("'https://chat.divinci.app/*'")
    expect(prodBranch).not.toMatch(/chat\.stage|chat\.dev|localhost/)
  })

  it('dev builds are a superset that still includes production', () => {
    // vitest runs with DEV=true, so this asserts the dev branch directly.
    expect(ALLOWED_WEB_APP_ORIGINS).toContain('https://chat.divinci.app')
    expect(ALLOWED_WEB_APP_ORIGINS).toContain('http://localhost:8080')
  })
})

describe('store-packaging guards', () => {
  it('refuses to zip a production build while the Auth0 client id is unset', () => {
    expect(config).toContain('PROD_AUTH0_CLIENT_ID_UNSET')
    expect(config).toMatch(/Refusing to `zip` a production build/)
    expect(PROD_AUTH0_CLIENT_ID_UNSET).toBe('__SET_PROD_AUTH0_CLIENT_ID__')
  })

  it('keeps `key` out of non-development builds', () => {
    // The Chrome Web Store REJECTS a new item whose manifest carries `key`
    // ("key field is not allowed in manifest."). It is not stripped for you.
    expect(config).toMatch(/\.\.\.\(mode === 'development' \? \{ key: MANIFEST_PUBLIC_KEY \} : \{\}\)/)
    expect(config).not.toMatch(/^\s+key: MANIFEST_PUBLIC_KEY,$/m)
  })

  it('still refuses to zip a development build', () => {
    expect(config).toMatch(/Refusing to `zip` a development build/)
  })
})

describe('web_accessible_resources exposure', () => {
  it('does NOT expose the app-logic chunks to every origin', () => {
    // These run in extension pages (offscreen document, side panel, popup),
    // never inside an iframe framed from a web page, so no web origin needs to
    // load them. The previous blanket `chunks/*.js` exposed all of them.
    for (const chunk of [
      'chunks/offscreen-BWEK10hF.js',
      'chunks/panel-D3-U-Zkb.js',
      'chunks/popup-MEC19YFC.js',
      'chunks/release-config-BmwwbeBv.js',
    ]) {
      expect(isMatched(chunk), chunk).toBe(false)
    }
  })

  it('exposes exactly what the two framed iframes need', () => {
    for (const chunk of [
      'chunks/robot-BHnmG0c1.js',
      'chunks/logo-robot-C9j7epgt.js',
      'chunks/inference-PzrYkxW5.js',
      'chunks/cache-breakdown-BRzTRB-q.js',
      'chunks/models-CfdpKjct.js',
      'chunks/logger-D_N_LeOO.js',
      'chunks/preload-helper-BrnWUoxD.js',
      'chunks/_virtual_wxt-html-plugins-Dwc3q2co.js',
      'assets/ort-wasm-simd-threaded.jsep-CCdEhX4k.wasm',
    ]) {
      expect(isMatched(chunk), chunk).toBe(true)
    }
  })

  it('no longer carries the blanket patterns', () => {
    expect(WEB_ACCESSIBLE_RESOURCES).not.toContain('chunks/*.js')
    expect(WEB_ACCESSIBLE_RESOURCES).not.toContain('assets/*')
    // A stylesheet for an extension page is not iframe surface.
    expect(isMatched('assets/popup-C4SEDBGH.css')).toBe(false)
  })
})
