/**
 * Pure helpers for the user-settings flow. Extracted from the offscreen
 * entrypoint so they're testable without spinning up the full chrome
 * runtime + caches API + ChatHost on every test boot.
 */

import { type UserSettings } from '@/shared/models'

/**
 * Validate and clamp a partial settings update against the allowed
 * range. Defense-in-depth: the popup's <input min max> already
 * constrains, but a misconfigured client could still send an
 * out-of-range value (e.g., temperature: 999). Returns a fresh
 * UserSettings — does not mutate `current`.
 */
export function clampSettings(
  input: {
    temperature?: unknown; maxNewTokens?: unknown;
    cfAccountId?: unknown; cfApiToken?: unknown; braveApiKey?: unknown; serperApiKey?: unknown;
    useDivinciAccount?: unknown; divinciWorkspaceId?: unknown; divinciReleaseId?: unknown;
    theme?: unknown;
  },
  current: UserSettings
): UserSettings {
  const next: UserSettings = { ...current }
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    next.temperature = Math.max(0, Math.min(2, input.temperature))
  }
  if (typeof input.maxNewTokens === 'number' && Number.isFinite(input.maxNewTokens)) {
    next.maxNewTokens = Math.max(1, Math.min(8192, Math.round(input.maxNewTokens)))
  }
  if (typeof input.cfAccountId === 'string') {
    next.cfAccountId = input.cfAccountId
  }
  if (typeof input.cfApiToken === 'string') {
    next.cfApiToken = input.cfApiToken
  }
  if (typeof input.braveApiKey === 'string') {
    next.braveApiKey = input.braveApiKey
  }
  if (typeof input.serperApiKey === 'string') {
    next.serperApiKey = input.serperApiKey
  }
  if (typeof input.useDivinciAccount === 'boolean') {
    next.useDivinciAccount = input.useDivinciAccount
  }
  if (typeof input.divinciWorkspaceId === 'string') {
    next.divinciWorkspaceId = input.divinciWorkspaceId
  }
  if (typeof input.divinciReleaseId === 'string') {
    next.divinciReleaseId = input.divinciReleaseId
  }
  if (input.theme === 'system' || input.theme === 'light' || input.theme === 'dark') {
    next.theme = input.theme
  }
  return next
}
