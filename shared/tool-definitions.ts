/**
 * Tool definitions shared between the Kimi tool loop and the web search
 * execution layer. These are the canonical ChatTool entries the extension
 * registers with Kimi K2.7-Code.
 */

import type { ChatTool } from '@/shared/messages'

/**
 * Web search tool allowing Kimi K2.7-Code to query current information.
 * Uses the Brave Search API or Serper.dev API under the hood.
 */
export const WEB_SEARCH_TOOL: ChatTool = {
  name: 'web_search',
  description:
    'Search the web for current information. Use this when the user asks about recent events, current data, or any topic that requires up-to-date information beyond the model\'s training cutoff.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query string, same as you would type into a search engine.',
      },
      count: {
        type: 'integer',
        description: 'Number of search results to return (default: 5, max: 10).',
        default: 5,
      },
    },
    required: ['query'],
  },
}

/**
 * All tools the extension exposes for Kimi K2.7-Code to call.
 * Add new tools here and implement the corresponding executor in
 * offscreen/tool-executors.ts.
 */
export const REGISTERED_TOOLS: ChatTool[] = [
  WEB_SEARCH_TOOL,
]
