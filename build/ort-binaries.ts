/**
 * Every ONNX Runtime build we bundle must find its wasm binaries in `ort/`.
 *
 * ORT ships one wasm variant per bundle, and the bundles do not agree:
 *
 *   onnxruntime-web          → ort.bundle.min.mjs        → …jsep.{mjs,wasm}
 *   onnxruntime-web/webgpu   → ort.webgpu.bundle.min.mjs → …asyncify.{mjs,wasm}
 *
 * `wasmPaths` is a PREFIX, not a file: ORT loads
 * `${wasmPaths}${theFilenameThisBuildWants}`. So pointing it at a directory
 * that exists, containing a binary from a different bundle, gets you a clean
 * prefix and a 404 — with no error the caller can attribute to the manifest or
 * the config. `offscreen/wake-host.ts` shipped that way from `adce0ec` until
 * 2026-08-21: it imported the default bundle, `copyOrtFiles()` copied only
 * asyncify, and every wake-word start failed on its runtime. It is opt-in, so
 * nobody hit it.
 *
 * The required filenames are read out of ORT's own dist rather than listed
 * here, so an ORT upgrade that renames a binary fails the build instead of
 * silently 404ing at runtime.
 */

export interface OrtRequirement {
  /** e.g. `ort.webgpu.bundle.min.mjs` — the ORT build inlined in a chunk. */
  bundle: string
  /** Built files that inline it. */
  usedBy: string[]
  /** Files that must exist in the shipped `ort/` directory. */
  requires: string[]
}

interface FsLike {
  existsSync(p: string): boolean
  readFileSync(p: string, enc: 'utf-8'): string
  readdirSync(p: string): string[]
}

/** Which ORT bundles the build actually inlines, and what each one needs. */
export function ortRequirements(
  outDir: string,
  ortDistDir: string,
  fs: FsLike,
  join: (...parts: string[]) => string,
): OrtRequirement[] {
  const byBundle = new Map<string, Set<string>>()

  const scan = (dir: string, prefix: string) => {
    if (!fs.existsSync(join(outDir, dir))) return
    for (const f of fs.readdirSync(join(outDir, dir))) {
      if (!f.endsWith('.js')) continue
      const src = fs.readFileSync(join(outDir, dir, f), 'utf-8')
      for (const m of src.matchAll(/\b(ort(?:\.[a-z]+)*\.bundle\.min\.mjs)\b/g)) {
        const set = byBundle.get(m[1]) ?? new Set<string>()
        set.add(`${prefix}${f}`)
        byBundle.set(m[1], set)
      }
    }
  }
  scan('chunks', 'chunks/')
  scan('content-scripts', 'content-scripts/')
  scan('.', '')

  return [...byBundle.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bundle, usedBy]) => {
      const distPath = join(ortDistDir, bundle)
      // An mjs name we cannot read is not evidence of anything; report the
      // bundle with no requirements rather than inventing filenames.
      const mjs = fs.existsSync(distPath)
        ? [
            ...new Set(
              [...fs.readFileSync(distPath, 'utf-8').matchAll(/ort-wasm-simd-threaded[a-z.]*\.mjs/g)].map(
                (m) => m[0],
              ),
            ),
          ]
        : []
      return {
        bundle,
        usedBy: [...usedBy].sort(),
        requires: mjs.flatMap((f) => [f, f.replace(/\.mjs$/, '.wasm')]).sort(),
      }
    })
}

/** Required binaries missing from the shipped `ort/` directory. */
export function missingOrtBinaries(
  outDir: string,
  ortDistDir: string,
  fs: FsLike,
  join: (...parts: string[]) => string,
): { bundle: string; file: string; usedBy: string[] }[] {
  const shipped = fs.existsSync(join(outDir, 'ort'))
    ? new Set(fs.readdirSync(join(outDir, 'ort')))
    : new Set<string>()
  return ortRequirements(outDir, ortDistDir, fs, join).flatMap((r) =>
    r.requires
      .filter((f) => !shipped.has(f))
      .map((file) => ({ bundle: r.bundle, file, usedBy: r.usedBy })),
  )
}
