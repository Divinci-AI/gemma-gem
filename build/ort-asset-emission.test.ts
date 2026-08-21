import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { stripUnusedOrtWasmAsset, emittedWasmAssets } from './ort-asset-emission'

const ORT_ID = '/x/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs'

describe('stripUnusedOrtWasmAsset', () => {
  it('leaves the evaluated string byte-identical', () => {
    const p = stripUnusedOrtWasmAsset()
    const out = p.transform('a=new URL("ort-wasm-simd-threaded.asyncify.wasm",import.meta.url)', ORT_ID)!
    // eslint-disable-next-line no-eval
    const rebuilt = out.code.match(/new URL\((.*),import\.meta\.url\)/)![1]
    // eslint-disable-next-line no-eval
    expect(eval(rebuilt)).toBe('ort-wasm-simd-threaded.asyncify.wasm')
  })

  it('breaks the literal so a static analyser cannot resolve it', () => {
    const p = stripUnusedOrtWasmAsset()
    const out = p.transform('new URL("ort-wasm-simd-threaded.asyncify.wasm",import.meta.url)', ORT_ID)!
    expect(out.code).not.toContain('"ort-wasm-simd-threaded.asyncify.wasm"')
    expect(out.code).toContain('+')
    expect(p.rewrites).toBe(1)
  })

  it('rewrites every site, not just the first', () => {
    // There are two: the locateFile fallback and the proxy-worker init. Missing
    // either leaves Vite emitting the asset and the change buys nothing.
    const p = stripUnusedOrtWasmAsset()
    const code = 'new URL("ort-wasm-a.wasm",import.meta.url);new URL("ort-wasm-b.wasm", import.meta.url)'
    p.transform(code, ORT_ID)
    expect(p.rewrites).toBe(2)
  })

  it('handles single quotes and spacing', () => {
    const p = stripUnusedOrtWasmAsset()
    expect(p.transform("new URL('ort-wasm-x.wasm' , import.meta.url)", ORT_ID)).not.toBeNull()
    expect(p.rewrites).toBe(1)
  })

  it('touches nothing outside onnxruntime-web', () => {
    const p = stripUnusedOrtWasmAsset()
    const code = 'new URL("ort-wasm-simd-threaded.asyncify.wasm",import.meta.url)'
    expect(p.transform(code, '/x/src/our-own-module.ts')).toBeNull()
    expect(p.rewrites).toBe(0)
  })

  it('does not rewrite a non-wasm asset URL', () => {
    const p = stripUnusedOrtWasmAsset()
    expect(p.transform('new URL("ort-wasm-proxy-worker.mjs",import.meta.url)', ORT_ID)).toBeNull()
  })

  it('is not confused by a previous call — the regex is global and stateful', () => {
    // A /g regex carries lastIndex between .test() calls. Reusing one across
    // modules without resetting it makes the plugin skip files at random,
    // which would show up as an intermittently 24 MB larger package.
    const p = stripUnusedOrtWasmAsset()
    const code = 'new URL("ort-wasm-x.wasm",import.meta.url)'
    expect(p.transform(code, ORT_ID)).not.toBeNull()
    expect(p.transform(code, ORT_ID)).not.toBeNull()
    expect(p.transform(code, ORT_ID)).not.toBeNull()
    expect(p.rewrites).toBe(3)
  })
})

describe('emittedWasmAssets', () => {
  const fs = {
    existsSync: (p: string) => p.endsWith('assets'),
    readdirSync: () => ['popup-ABC.css', 'ort-wasm-simd-threaded.asyncify-HASH.wasm'],
  }
  const join = (...p: string[]) => p.join('/')

  it('flags a wasm Vite emitted into assets/', () => {
    expect(emittedWasmAssets('out', fs, join)).toEqual([
      'assets/ort-wasm-simd-threaded.asyncify-HASH.wasm',
    ])
  })

  it('ignores non-wasm assets', () => {
    expect(
      emittedWasmAssets('out', { existsSync: () => true, readdirSync: () => ['a.css'] }, join),
    ).toEqual([])
  })

  it('is empty when there is no assets directory at all', () => {
    expect(emittedWasmAssets('out', { existsSync: () => false, readdirSync: () => [] }, join)).toEqual([])
  })

  it.runIf(existsSync('.output/chrome-mv3'))('the real build emits none', () => {
    expect(emittedWasmAssets('.output/chrome-mv3', { existsSync, readdirSync }, join)).toEqual([])
  })
})
