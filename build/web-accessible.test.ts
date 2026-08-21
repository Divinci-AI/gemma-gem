import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  WEB_ACCESSIBLE_RESOURCES,
  isMatched,
  pageContextRefs,
  unexposedPageContextRefs,
  unnecessaryExposure,
} from './web-accessible'

/** A fake build output. Keys are extension-root-relative paths. */
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
        if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0])
      }
      return [...out]
    },
  }
}
const join = (...parts: string[]) => parts.join('/')

describe('isMatched', () => {
  it('matches a hashed name through a single glob', () => {
    expect(isMatched('chunks/robot-ABC.js', ['chunks/robot-*.js'])).toBe(true)
  })

  it('does not let * cross a path separator', () => {
    expect(isMatched('assets/nested/secret.css', ['assets/*'])).toBe(false)
  })

  it('anchors at both ends', () => {
    expect(isMatched('evil/robot.html', ['robot.html'])).toBe(false)
    expect(isMatched('robot.html.bak', ['robot.html'])).toBe(false)
  })
})

describe('pageContextRefs', () => {
  it('reads getURL paths out of every content-script bundle', () => {
    const fs = fakeFs({
      'content-scripts/content.js': 'chrome.runtime.getURL("inference.html")',
      'content-scripts/other.js': 'chrome.runtime.getURL("robot.html")',
      'inference.html': '',
      'robot.html': '',
    })
    expect(pageContextRefs('out', fs, join)).toEqual([
      { path: 'inference.html', script: 'content-scripts/content.js' },
      { path: 'robot.html', script: 'content-scripts/other.js' },
    ])
  })

  it('ignores getURL("") — that is the origin, not a file', () => {
    const fs = fakeFs({ 'content-scripts/content.js': 'new URL(chrome.runtime.getURL("")).origin' })
    expect(pageContextRefs('out', fs, join)).toEqual([])
  })

  it('normalises a leading slash, which WXT emits', () => {
    const fs = fakeFs({
      'content-scripts/content.js': 'getURL("/content-scripts/content.css")',
      'content-scripts/content.css': '',
    })
    expect(pageContextRefs('out', fs, join)[0].path).toBe('content-scripts/content.css')
  })

  it('sees a template literal, which a minifier keeps', () => {
    // getURL(`ort/${name}`) resolves a directory the same way getURL('ort/')
    // does. Matching only quotes would miss it entirely.
    const fs = fakeFs({ 'content-scripts/content.js': 'getURL(`ort/${name}`)' })
    expect(pageContextRefs('out', fs, join)[0].path).toBe('ort/')
  })

  it('does not read the extension chunks — only content scripts reach the page', () => {
    const fs = fakeFs({
      'content-scripts/content.js': '',
      'chunks/panel-A.js': 'chrome.runtime.getURL("panel-only.png")',
    })
    expect(pageContextRefs('out', fs, join)).toEqual([])
  })
})

describe('unexposedPageContextRefs', () => {
  it('reports a path the content script hands the page but the manifest hides', () => {
    const fs = fakeFs({
      'content-scripts/content.js': 'getURL("robot.html");getURL("secret.html")',
      'robot.html': '',
      'secret.html': '',
    })
    expect(unexposedPageContextRefs('out', fs, join, ['robot.html'])).toEqual([
      { path: 'secret.html', script: 'content-scripts/content.js' },
    ])
  })

  it('stays quiet about a path that is not in the build at all', () => {
    // WXT's createShadowRootUi fetches content-scripts/<name>.css whether or
    // not one was emitted. That 404 is not a manifest problem, and reporting
    // it here would send someone to expose a file that does not exist.
    const fs = fakeFs({ 'content-scripts/content.js': 'getURL("/content-scripts/content.css")' })
    expect(unexposedPageContextRefs('out', fs, join, [])).toEqual([])
  })
})

describe('unnecessaryExposure', () => {
  it('reports a pattern no page-context path needs', () => {
    const fs = fakeFs({
      'content-scripts/content.js': 'getURL("robot.html")',
      'robot.html': '',
      'chunks/robot-A.js': '',
    })
    expect(unnecessaryExposure('out', fs, join, ['robot.html', 'chunks/robot-*.js'])).toEqual([
      'chunks/robot-*.js',
    ])
  })

  it('is empty when every pattern earns its place', () => {
    const fs = fakeFs({
      'content-scripts/content.js': 'getURL("robot.html");getURL("inference.html")',
      'robot.html': '',
      'inference.html': '',
    })
    expect(unnecessaryExposure('out', fs, join, ['robot.html', 'inference.html'])).toEqual([])
  })
})

describe('the real build output', () => {
  const realFs = { existsSync, readFileSync, readdirSync }

  for (const outDir of ['.output/chrome-mv3', '.output/chrome-mv3-dev']) {
    const built = existsSync(outDir)

    it.runIf(built)(`${outDir}: every page-context path is exposed`, () => {
      expect(unexposedPageContextRefs(outDir, realFs, join)).toEqual([])
    })

    it.runIf(built)(`${outDir}: nothing is exposed that the page never loads`, () => {
      expect(unnecessaryExposure(outDir, realFs, join)).toEqual([])
    })
  }

  it('exposes documents only — never a chunk, an asset or a wasm binary', () => {
    // The measured rule: a framed extension page loads its own sub-resources
    // without an entry. An entry for anything but a framed DOCUMENT is
    // surface bought for nothing.
    for (const p of WEB_ACCESSIBLE_RESOURCES) {
      expect(p, `${p} is not a framed document`).toMatch(/\.html$/)
    }
  })

  it('never exposes a whole directory', () => {
    for (const p of WEB_ACCESSIBLE_RESOURCES) {
      expect(p, `${p} exposes a directory to every origin`).not.toMatch(/\/\*$|^\*/)
    }
  })
})
