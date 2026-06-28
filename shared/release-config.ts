/**
 * Site-supplied release config (Phase 6) — the subset of a Divinci web release
 * a website may hand the extension so the panel presents a BRANDED assistant
 * (greeting, suggested starters, grounding context, languages, theme).
 *
 * Field names mirror the web app's portable release config
 * (`workspace/sdk/packages/types/src/schemas/release.ts` ReleaseConfigSchema:
 * `systemPrompt`, `welcomeMessage`, `conversationStarters`) so the SAME YAML a
 * site authors validates as a release. The extension repo is outside the pnpm
 * workspace, so we can't import that zod schema; this is a hand-written,
 * dependency-free validator with the same shape + the same limits.
 *
 * SECURITY: `systemPrompt` is site-supplied input that reaches the user's local
 * model (prompt-injection surface, same class as the removed `tools` forward).
 * It is stored per-origin, applied only to that origin's panel session,
 * ATTRIBUTED in the UI, and never overrides the extension's own identity/safety
 * framing. parseReleaseConfig clamps every field and drops anything malformed —
 * a hostile config can at most degrade its OWN site's experience.
 *
 * Pure (no chrome.*, no DOM) so the validation is fully unit-testable.
 */

/** chrome.storage.local key: origin → SiteReleaseConfig. */
export const STORAGE_KEY_SITE_CONFIGS = "divinci_site_configs";

// Limits mirror the web release schema.
const MAX_WELCOME = 2000;
const MAX_SYSTEM_PROMPT = 10_000;
const MAX_STARTERS = 10;
const MAX_STARTER_LEN = 200;
const MAX_LANGS = 50;
const MAX_LANG_LEN = 35; // generous BCP-47 (e.g. "zh-Hans-CN")

/** Minimal theme subset the panel can apply without the full web ThemeConfig. */
export interface SiteThemeConfig {
  /** A named web preset, or "custom" with colors. Free-form; the panel maps known ones. */
  preset?: string;
  /** Accent / primary color (validated as a CSS hex). */
  accent?: string;
}

/** The validated, clamped config the extension stores + applies. */
export interface SiteReleaseConfig {
  welcomeMessage?: string;
  conversationStarters?: string[];
  systemPrompt?: string;
  supportedLanguages?: string[];
  theme?: SiteThemeConfig;
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

/** #rgb / #rrggbb only — blocks url()/expression()/javascript: in a style value. */
function cleanHexColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t : undefined;
}

function cleanStarters(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const s = cleanString(item, MAX_STARTER_LEN);
    if (s) out.push(s);
    if (out.length >= MAX_STARTERS) break;
  }
  return out.length ? out : undefined;
}

function cleanLanguages(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    // BCP-47-ish: letters, digits, hyphens only (drops anything injectable).
    const t = item.trim();
    if (t && /^[A-Za-z0-9-]+$/.test(t) && t.length <= MAX_LANG_LEN) out.push(t);
    if (out.length >= MAX_LANGS) break;
  }
  return out.length ? out : undefined;
}

function cleanTheme(v: unknown): SiteThemeConfig | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const preset = cleanString(o.preset, 40);
  const accent = cleanHexColor(o.accent ?? (o.colors as { accent?: unknown } | undefined)?.accent);
  if (!preset && !accent) return undefined;
  const theme: SiteThemeConfig = {};
  if (preset) theme.preset = preset;
  if (accent) theme.accent = accent;
  return theme;
}

/**
 * Validate + clamp a raw site config into a SiteReleaseConfig. Unknown/malformed
 * fields are dropped (never throws). Returns null when NOTHING usable remains so
 * the caller can reject an empty/garbage configure() call.
 *
 * Accepts the web release field names (`welcomeMessage`, `conversationStarters`,
 * `systemPrompt`) AND tolerates the design-doc aliases (`welcome`, `starters`,
 * `systemContext`) so either authoring style works.
 */
export function parseReleaseConfig(raw: unknown): SiteReleaseConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;

  const config: SiteReleaseConfig = {};
  const welcome = cleanString(o.welcomeMessage ?? o.welcome, MAX_WELCOME);
  if (welcome) config.welcomeMessage = welcome;

  const starters = cleanStarters(o.conversationStarters ?? o.starters);
  if (starters) config.conversationStarters = starters;

  const sys = cleanString(o.systemPrompt ?? o.systemContext, MAX_SYSTEM_PROMPT);
  if (sys) config.systemPrompt = sys;

  const langs = cleanLanguages(o.supportedLanguages);
  if (langs) config.supportedLanguages = langs;

  const theme = cleanTheme(o.theme);
  if (theme) config.theme = theme;

  return Object.keys(config).length ? config : null;
}

export type SiteConfigMap = Record<string, SiteReleaseConfig>;

/** Defensive sanitize of the stored map (drops invalid origins/configs). */
export function sanitizeSiteConfigMap(
  raw: unknown,
  isValidOrigin: (o: string) => boolean,
): SiteConfigMap {
  if (!raw || typeof raw !== "object") return {};
  const out: SiteConfigMap = {};
  for (const [origin, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidOrigin(origin)) continue;
    const cfg = parseReleaseConfig(val);
    if (cfg) out[origin] = cfg;
  }
  return out;
}
