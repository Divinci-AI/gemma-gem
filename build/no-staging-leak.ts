/**
 * A production build must not carry staging/dev/localhost hostnames in its
 * JavaScript.
 *
 * This is not cosmetic. The store listing's permission justification states that
 * `api.divinci.app` and `divinci-prod.us.auth0.com` are the only hosts the
 * extension is granted; a reviewer running `strings` over the package and
 * finding `api.stage.divinci.app` sees a contradiction. It is also an internal
 * infrastructure disclosure in a public artifact.
 *
 * It regressed once already and the manifest was clean throughout — the leak was
 * in the BUNDLE, from a `typeof import.meta !== 'undefined' && …env?.DEV` guard
 * that esbuild could not fold, so the dead staging branch survived into
 * background.js. Nothing in the manifest, the tests or the type system could see
 * it. Only reading the built output can.
 */

/** Hostnames that must never appear in a production bundle. */
export const FORBIDDEN_IN_PRODUCTION = [
  'api.stage.divinci.app',
  'api.dev.divinci.app',
  'chat.stage.divinci.app',
  'chat.dev.divinci.app',
  'embed.stage.divinci.app',
  'divinci-staging.us.auth0.com',
  'localhost:8080',
  'localhost:9080',
]

export interface Leak {
  file: string
  needle: string
}

/**
 * Scan every emitted `.js` under `outDir` for forbidden hostnames.
 * Returns [] when the build is clean.
 */
export function findStagingLeaks(
  outDir: string,
  fs: {
    readdirSync(p: string, o: { withFileTypes: true }): Array<{ name: string; isDirectory(): boolean }>
    readFileSync(p: string, enc: 'utf-8'): string
  },
  join: (...parts: string[]) => string,
  needles: string[] = FORBIDDEN_IN_PRODUCTION,
): Leak[] {
  const leaks: Leak[] = []

  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(abs, relPath)
        continue
      }
      if (!entry.name.endsWith('.js')) continue
      const src = fs.readFileSync(abs, 'utf-8')
      for (const needle of needles) {
        if (src.includes(needle)) leaks.push({ file: relPath, needle })
      }
    }
  }

  walk(outDir, '')
  return leaks
}
