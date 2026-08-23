/**
 * Should the in-page launcher handle be shown?
 *
 * Through 0.14.8 it was shown on EVERY page by default — a purple star tab
 * pinned to the right edge of every site you visit. That is not what browser
 * extensions conventionally do, and it was reported as intrusive. The default
 * is now off: the toolbar icon opens the dock, the way the rest of the
 * ecosystem works.
 *
 * The storage key changed with the default, deliberately.
 * `divinci_sidebar_handle_hidden` defaulting to "hidden" would read backwards
 * at every call site (`hidden !== true` meaning shown), which is how a
 * polarity bug gets written later. The new key states the thing it controls.
 *
 * The legacy key is still honoured for one case that carries real intent:
 * a 0.14.8 user who hid the handle by double-clicking it and then RE-ENABLED
 * it from the popup wrote `hidden === false` explicitly. Dropping that would
 * silently take the handle away from the one group who had actively asked for
 * it. Everyone else — including the majority who never touched the setting —
 * gets the new default.
 */
export const STORAGE_KEY_HANDLE_SHOWN = 'divinci_sidebar_handle_shown'

export interface HandleVisibilityStore {
  [key: string]: unknown
}

export function shouldShowHandle(
  stored: HandleVisibilityStore | undefined,
  legacyHiddenKey: string,
): boolean {
  const shown = stored?.[STORAGE_KEY_HANDLE_SHOWN]
  if (typeof shown === 'boolean') return shown
  // Explicit `false` under the old key = "I turned this back on".
  if (stored?.[legacyHiddenKey] === false) return true
  return false
}

/**
 * The value to persist when migrating, or null when there is nothing to
 * migrate. Writing on every read would churn storage and fire the change
 * listener in every tab on every page load.
 */
export function handleMigration(
  stored: HandleVisibilityStore | undefined,
  legacyHiddenKey: string,
): boolean | null {
  if (typeof stored?.[STORAGE_KEY_HANDLE_SHOWN] === 'boolean') return null
  if (stored?.[legacyHiddenKey] === false) return true
  return null
}
