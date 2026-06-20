/**
 * Pure helpers for the per-tab vs global active-conversation model.
 *
 * - Per-tab (default): each browser tab points at its own conversation via a
 *   `{ [tabId]: convId }` map, so a thread stays coherent to the page/tab.
 * - Global ("follow-me") mode: one shared pointer follows the user across all
 *   tabs.
 *
 * Framework-free + side-effect-free so they can be unit-tested without chrome.
 */

export interface ActiveConvContext {
  globalMode: boolean
  /** null when the SW couldn't resolve a tabId (falls back to global pointer). */
  tabId: number | null
  globalConvId: string | null
  tabMap: Record<string, string>
}

/** Which conversation id is active for the current tab + mode. */
export function resolveActiveConvId(ctx: ActiveConvContext): string | null {
  if (ctx.globalMode || ctx.tabId == null) return ctx.globalConvId
  return ctx.tabMap[String(ctx.tabId)] ?? null
}

/** Return a new tab→conv map with this tab's pointer set (does not mutate). */
export function setTabActive(
  tabMap: Record<string, string>,
  tabId: number,
  convId: string,
): Record<string, string> {
  return { ...tabMap, [String(tabId)]: convId }
}
