import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  STORAGE_KEY_HANDLE_SHOWN,
  shouldShowHandle,
  handleMigration,
} from './handle-visibility'
import { STORAGE_KEY_HANDLE_HIDDEN } from './models'

const LEGACY = STORAGE_KEY_HANDLE_HIDDEN

describe('shouldShowHandle', () => {
  it('is OFF for a user who never touched the setting', () => {
    // The whole point of the change: a fresh install puts nothing on top of
    // the pages you visit.
    expect(shouldShowHandle({}, LEGACY)).toBe(false)
    expect(shouldShowHandle(undefined, LEGACY)).toBe(false)
  })

  it('is OFF for a 0.14.8 user who hid it', () => {
    expect(shouldShowHandle({ [LEGACY]: true }, LEGACY)).toBe(false)
  })

  it('is ON for a 0.14.8 user who explicitly turned it back on', () => {
    // `hidden === false` is only ever written by the popup toggle, so it is
    // real intent — not a default. Taking the handle from the one group who
    // asked for it would be the worst outcome of this change.
    expect(shouldShowHandle({ [LEGACY]: false }, LEGACY)).toBe(true)
  })

  it('lets the new key win over the legacy one', () => {
    expect(shouldShowHandle({ [STORAGE_KEY_HANDLE_SHOWN]: false, [LEGACY]: false }, LEGACY)).toBe(false)
    expect(shouldShowHandle({ [STORAGE_KEY_HANDLE_SHOWN]: true, [LEGACY]: true }, LEGACY)).toBe(true)
  })

  it('ignores non-boolean junk under the new key', () => {
    expect(shouldShowHandle({ [STORAGE_KEY_HANDLE_SHOWN]: 'yes' }, LEGACY)).toBe(false)
    expect(shouldShowHandle({ [STORAGE_KEY_HANDLE_SHOWN]: 1 }, LEGACY)).toBe(false)
  })
})

describe('handleMigration', () => {
  it('migrates only the explicit re-enable', () => {
    expect(handleMigration({ [LEGACY]: false }, LEGACY)).toBe(true)
  })

  it('writes nothing for everyone else', () => {
    // A write on every page load would fire storage.onChanged in every tab.
    expect(handleMigration({}, LEGACY)).toBeNull()
    expect(handleMigration({ [LEGACY]: true }, LEGACY)).toBeNull()
    expect(handleMigration({ [STORAGE_KEY_HANDLE_SHOWN]: true, [LEGACY]: false }, LEGACY)).toBeNull()
  })
})

describe('the handle is not the only way in', () => {
  it('the popup offers an explicit open action', () => {
    // Defaulting the handle off strands the in-page dock unless the toolbar
    // icon can open it — through 0.14.8 the handle was the ONLY entry point.
    const html = readFileSync(resolve(__dirname, '../entrypoints/popup/index.html'), 'utf-8')
    expect(html).toContain('id="open-overlay-btn"')
    const main = readFileSync(resolve(__dirname, '../entrypoints/popup/main.ts'), 'utf-8')
    expect(main).toContain("'internal:open-overlay'")
  })
})
