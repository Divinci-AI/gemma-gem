import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { ortRequirements, missingOrtBinaries } from './ort-binaries'

function fakeFs(tree: Record<string, string>) {
  const files = new Set(Object.keys(tree))
  const dirs = new Set<string>([''])
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const strip = (p: string) => p.replace(/^out\/?/, '').replace(/^dist\/?/, 'DIST/').replace(/\/$/, '').replace(/\/\.$/, '')
  return {
    existsSync: (p: string) => files.has(strip(p)) || dirs.has(strip(p)),
    readFileSync: (p: string) => {
      const v = tree[strip(p)]
      if (v === undefined) throw new Error(`ENOENT ${p}`)
      return v
    },
    readdirSync: (p: string) => {
      const d = strip(p)
      if (!dirs.has(d)) throw new Error(`ENOTDIR ${p}`)
      const prefix = d === '' ? '' : `${d}/`
      const out = new Set<string>()
      for (const f of files) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0])
      return [...out]
    },
  }
}
const join = (...p: string[]) => p.join('/')

/** The shape that matters: two bundles, two different wasm variants. */
const DIST = {
  'DIST/ort.bundle.min.mjs': 'x=new URL("ort-wasm-simd-threaded.jsep.mjs",import.meta.url)',
  'DIST/ort.webgpu.bundle.min.mjs': 'x=new URL("ort-wasm-simd-threaded.asyncify.mjs",import.meta.url)',
}

describe('ortRequirements', () => {
  it('reads the required filenames out of ORT dist, not a hardcoded list', () => {
    const fs = fakeFs({
      ...DIST,
      'chunks/a.js': 'import("ort.webgpu.bundle.min.mjs")',
    })
    expect(ortRequirements('out', 'dist', fs, join)).toEqual([
      {
        bundle: 'ort.webgpu.bundle.min.mjs',
        usedBy: ['chunks/a.js'],
        requires: ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'],
      },
    ])
  })

  it('reports each bundle the build inlines, and who inlines it', () => {
    const fs = fakeFs({
      ...DIST,
      'chunks/a.js': '"ort.webgpu.bundle.min.mjs"',
      'chunks/b.js': '"ort.bundle.min.mjs"',
      'content-scripts/c.js': '"ort.webgpu.bundle.min.mjs"',
    })
    const r = ortRequirements('out', 'dist', fs, join)
    expect(r.map((x) => x.bundle)).toEqual(['ort.bundle.min.mjs', 'ort.webgpu.bundle.min.mjs'])
    expect(r[1].usedBy).toEqual(['chunks/a.js', 'content-scripts/c.js'])
  })

  it('claims nothing when the dist bundle cannot be read', () => {
    // An unreadable bundle is not evidence that a file is missing. Inventing a
    // filename here would fail the build for a guard's own blind spot.
    const fs = fakeFs({ 'chunks/a.js': '"ort.webgpu.bundle.min.mjs"' })
    expect(ortRequirements('out', 'dist', fs, join)[0].requires).toEqual([])
  })
})

describe('missingOrtBinaries', () => {
  it('catches the wake-host bug: right directory, wrong variant', () => {
    const fs = fakeFs({
      ...DIST,
      'chunks/offscreen.js': '"ort.bundle.min.mjs"',
      'ort/ort-wasm-simd-threaded.asyncify.mjs': '',
      'ort/ort-wasm-simd-threaded.asyncify.wasm': '',
    })
    expect(missingOrtBinaries('out', 'dist', fs, join).map((m) => m.file)).toEqual([
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm',
    ])
  })

  it('is empty once both consumers share one variant', () => {
    const fs = fakeFs({
      ...DIST,
      'chunks/offscreen.js': '"ort.webgpu.bundle.min.mjs"',
      'chunks/cache.js': '"ort.webgpu.bundle.min.mjs"',
      'ort/ort-wasm-simd-threaded.asyncify.mjs': '',
      'ort/ort-wasm-simd-threaded.asyncify.wasm': '',
    })
    expect(missingOrtBinaries('out', 'dist', fs, join)).toEqual([])
  })

  it('reports everything when ort/ is absent entirely', () => {
    const fs = fakeFs({ ...DIST, 'chunks/a.js': '"ort.webgpu.bundle.min.mjs"' })
    expect(missingOrtBinaries('out', 'dist', fs, join)).toHaveLength(2)
  })
})

describe('the real build', () => {
  const outDir = '.output/chrome-mv3'
  const ortDist = resolve(dirname(createRequire(import.meta.url).resolve('onnxruntime-web')))
  const realFs = { existsSync, readFileSync, readdirSync }

  it.runIf(existsSync(outDir))('ships every binary the bundled ORT builds need', () => {
    expect(missingOrtBinaries(outDir, ortDist, realFs, join)).toEqual([])
  })

  it.runIf(existsSync(outDir))('inlines exactly ONE ORT build', () => {
    // Two builds means two ~24 MB wasm variants. The extension carried both
    // until 2026-08-21, and the second one was never loadable.
    const bundles = ortRequirements(outDir, ortDist, realFs, join).map((r) => r.bundle)
    expect(bundles).toEqual(['ort.webgpu.bundle.min.mjs'])
  })
})
