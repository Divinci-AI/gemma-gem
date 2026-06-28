/**
 * MAIN-world WebMCP CONSUMER shim (Phase 7c). Completes the bridge that
 * `shared/webmcp-consumer.ts` (PageWebMcpBridge, ISOLATED world) speaks: it
 * reads the page's WebMCP tools from `navigator.modelContext` /
 * `document.modelContext` (MAIN world — invisible to content scripts) and
 * lists / calls them on request, posting results back over the same
 * `WEBMCP_BRIDGE_NS` postMessage protocol.
 *
 * It is INERT until the isolated relay asks (a `list`/`call` request arrives);
 * a page with no modelContext simply returns an empty tool list. Tool execution
 * is the PAGE's own code running in its own world — the extension never gains
 * page privileges; it only invokes tools the page chose to expose.
 *
 * Tool contract (tolerant of the unsettled spec): an enumerable
 * `modelContext.tools: Array<{ name, description?, inputSchema?, execute(input) }>`
 * (also accepts `getTools()`). Calling runs the matching tool's `execute`.
 */

import { WEBMCP_BRIDGE_NS, type PageToolMeta } from '@/shared/webmcp-consumer'

interface PageTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  execute: (input: Record<string, unknown>) => unknown
}

interface ModelContextLike {
  tools?: PageTool[]
  getTools?: () => PageTool[]
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  main() {
    function ctx(): ModelContextLike | null {
      const nav = (navigator as unknown as { modelContext?: unknown }).modelContext
      if (nav && typeof nav === 'object') return nav as ModelContextLike
      const doc = (document as unknown as { modelContext?: unknown }).modelContext
      if (doc && typeof doc === 'object') return doc as ModelContextLike
      return null
    }

    function tools(): PageTool[] {
      const c = ctx()
      if (!c) return []
      if (Array.isArray(c.tools)) return c.tools
      if (typeof c.getTools === 'function') {
        try {
          const t = c.getTools()
          return Array.isArray(t) ? t : []
        } catch {
          return []
        }
      }
      return []
    }

    function reply(msg: Record<string, unknown>): void {
      window.postMessage({ ...msg, __ns: WEBMCP_BRIDGE_NS }, window.location.origin)
    }

    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window) return
      const d = e.data as { __ns?: string; id?: string; op?: string; name?: string; input?: Record<string, unknown> }
      if (!d || d.__ns !== WEBMCP_BRIDGE_NS || typeof d.id !== 'string') return

      if (d.op === 'list') {
        const meta: PageToolMeta[] = tools()
          .filter((t) => t && typeof t.name === 'string' && typeof t.execute === 'function')
          .map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }))
        reply({ id: d.id, op: 'list-result', tools: meta })
        return
      }

      if (d.op === 'call' && typeof d.name === 'string') {
        const tool = tools().find((t) => t?.name === d.name && typeof t.execute === 'function')
        if (!tool) {
          reply({ id: d.id, op: 'call-result', ok: false, error: `No such tool: ${d.name}` })
          return
        }
        // The page tool runs in the page's own world. Await possible promises.
        Promise.resolve()
          .then(() => tool.execute(d.input ?? {}))
          .then((result) => reply({ id: d.id, op: 'call-result', ok: true, result }))
          .catch((err) => reply({ id: d.id, op: 'call-result', ok: false, error: (err as Error)?.message ?? String(err) }))
        return
      }
    })
  },
})
