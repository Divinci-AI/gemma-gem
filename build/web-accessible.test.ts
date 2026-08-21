import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  WEB_ACCESSIBLE_RESOURCES,
  isMatched,
  reachableChunks,
  unmatchedWebAccessibleChunks,
  unmatchedRuntimeAssets,
} from './web-accessible'

/**
 * A fake build output. Keys are extension-root-relative paths; a key ending in
 * `/` is a directory. Deliberately not a mock of node:fs — the guards take fs
 * as a parameter precisely so a test can hand them a tree.
 */
function fakeFs(tree: Record<string, string>) {
  const files = new Set(Object.keys(tree))
  const dirs = new Set<string>()
  for (const f of files) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const strip = (p: string) => p.replace(/^out\/?/, '').replace(/\/$/, '')
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
      for (const f of files) {
        if (!f.startsWith(prefix)) continue
        out.add(f.slice(prefix.length).split('/')[0])
      }
      return [...out]
    },
  }
}
const join = (...parts: string[]) => parts.join('/')

describe('isMatched', () => {
  it('matches a hashed chunk through a single glob', () => {
    expect(isMatched('chunks/robot-ABC123.js', ['chunks/robot-*.js'])).toBe(true)
  })

  it('does not let * cross a path separator', () => {
    // The whole point of dropping `assets/*`: a glob must not reach into
    // a sibling directory and quietly expose it.
    expect(isMatched('assets/nested/secret.css', ['assets/*'])).toBe(false)
  })

  it('anchors at both ends', () => {
    expect(isMatched('evil/chunks/robot-A.js', ['chunks/robot-*.js'])).toBe(false)
    expect(isMatched('chunks/robot-A.js.map', ['chunks/robot-*.js'])).toBe(false)
  })
})

describe('reachableChunks', () => {
  it('follows the import graph transitively from the framed pages', () => {
    const fs = fakeFs({
      'robot.html': '<script src="/chunks/robot-A.js"></script>',
      'chunks/robot-A.js': 'import "./shared-B.js"',
      'chunks/shared-B.js': 'import "./deep-C.js"',
      'chunks/deep-C.js': '',
      // Reachable from an extension page only — must NOT appear.
      'chunks/panel-D.js': '',
    })
    expect([...reachableChunks('out', fs, join)].sort()).toEqual([
      'chunks/deep-C.js',
      'chunks/robot-A.js',
      'chunks/shared-B.js',
    ])
  })

  it('terminates on an import cycle', () => {
    const fs = fakeFs({
      'robot.html': '<script src="/chunks/a.js"></script>',
      'chunks/a.js': 'import "./b.js"',
      'chunks/b.js': 'import "./a.js"',
    })
    expect([...reachableChunks('out', fs, join)].sort()).toEqual(['chunks/a.js', 'chunks/b.js'])
  })
})

describe('unmatchedWebAccessibleChunks', () => {
  it('reports a reachable chunk no pattern covers', () => {
    const fs = fakeFs({
      'robot.html': '<script src="/chunks/robot-A.js"></script>',
      'chunks/robot-A.js': 'import "./lazy-B.js"',
      'chunks/lazy-B.js': '',
    })
    expect(unmatchedWebAccessibleChunks('out', fs, join, ['chunks/robot-*.js'])).toEqual([
      'chunks/lazy-B.js',
    ])
  })

  it('is empty when every reachable chunk is covered', () => {
    const fs = fakeFs({
      'robot.html': '<script src="/chunks/robot-A.js"></script>',
      'chunks/robot-A.js': '',
    })
    expect(unmatchedWebAccessibleChunks('out', fs, join, ['chunks/robot-*.js'])).toEqual([])
  })
})

describe('unmatchedRuntimeAssets', () => {
  const page = { 'inference.html': '<script src="/chunks/inference-A.js"></script>' }

  it('catches a getURL directory whose contents are not exposed', () => {
    // The real bug: chat-host.ts sets `wasmPaths = getURL('ort/')` at module
    // top level, the framed entrypoint imports chat-host, and the manifest
    // exposed only `assets/`. Every chunk resolved; the fetch 404'd.
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'chrome.runtime.getURL("ort/")',
      'ort/ort-wasm.wasm': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([
      { path: 'ort/ort-wasm.wasm', chunk: 'chunks/inference-A.js', reason: 'not-web-accessible' },
    ])
  })

  it('accepts the same directory once a pattern covers it', () => {
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'chrome.runtime.getURL("ort/")',
      'ort/ort-wasm-simd.wasm': '',
    })
    expect(
      unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js', 'ort/ort-wasm-*.wasm']),
    ).toEqual([])
  })

  it('expands a directory recursively, not one level', () => {
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'chrome.runtime.getURL("models/")',
      'models/wake/embed.onnx': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([
      {
        path: 'models/wake/embed.onnx',
        chunk: 'chunks/inference-A.js',
        reason: 'not-web-accessible',
      },
    ])
  })

  it('reports a path the build does not contain at all', () => {
    const fs = fakeFs({ ...page, 'chunks/inference-A.js': 'chrome.runtime.getURL("gone.wasm")' })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([
      { path: 'gone.wasm', chunk: 'chunks/inference-A.js', reason: 'missing-from-build' },
    ])
  })

  it('catches a root-relative asset literal, which is how Vite emits one', () => {
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'new URL("/assets/ort-wasm-simd.jsep-HASH.wasm",self.location.href)',
      'assets/ort-wasm-simd.jsep-HASH.wasm': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toHaveLength(1)
    expect(
      unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js', 'assets/ort-wasm-*.wasm']),
    ).toEqual([])
  })

  it('ignores a bare directory literal that is a dead library default', () => {
    // transformers.js ships `localModelPath = '/models/'` and we run with
    // allowLocalModels off, so nothing fetches it. A guard that reported this
    // would be noise, and noise is how a guard gets switched off.
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'const localModelPath="/models/";',
      'models/wake/embed.onnx': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([])
  })

  it('ignores getURL("") — that is the extension origin, not a file', () => {
    const fs = fakeFs({ ...page, 'chunks/inference-A.js': 'new URL(chrome.runtime.getURL("")).origin' })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([])
  })

  it('does not look at chunks the framed pages cannot reach', () => {
    // wasmPaths is set in offscreen code too, and the offscreen document is an
    // extension page: it needs no web_accessible_resources entry at all.
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': '',
      'chunks/offscreen-Z.js': 'chrome.runtime.getURL("ort/")',
      'ort/ort-wasm.wasm': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toEqual([])
  })

  it('reports each path once even when several literals name it', () => {
    const fs = fakeFs({
      ...page,
      'chunks/inference-A.js': 'getURL("ort/");"/ort/ort-wasm.wasm";"ort/ort-wasm.wasm"',
      'ort/ort-wasm.wasm': '',
    })
    expect(unmatchedRuntimeAssets('out', fs, join, ['chunks/inference-*.js'])).toHaveLength(1)
  })
})

describe('the real build output', () => {
  const outDir = '.output/chrome-mv3'
  const built = existsSync(outDir)
  const realFs = { existsSync, readFileSync, readdirSync }

  it.runIf(built)('has every reachable chunk exposed', () => {
    expect(unmatchedWebAccessibleChunks(outDir, realFs, join)).toEqual([])
  })

  it.runIf(built)('has every runtime-fetched path exposed', () => {
    expect(unmatchedRuntimeAssets(outDir, realFs, join)).toEqual([])
  })

  it('exposes both ORT locations, because which one wins is a runtime decision', () => {
    // Dropping either is a one-line edit that produces a stalled load rather
    // than an error. `assets/` is the URL Vite rewrites into ORT's bundle;
    // `ort/` is what `wasmPaths` points at.
    expect(WEB_ACCESSIBLE_RESOURCES).toContain('assets/ort-wasm-*.wasm')
    expect(WEB_ACCESSIBLE_RESOURCES).toContain('ort/ort-wasm-*.wasm')
  })

  it('never exposes a whole directory', () => {
    for (const p of WEB_ACCESSIBLE_RESOURCES) {
      expect(p, `${p} exposes a directory to every origin`).not.toMatch(/\/\*$|^\*/)
    }
  })
})
