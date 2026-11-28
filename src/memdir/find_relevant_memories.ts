/**
 * Query-time Sonnet relevance recall (`findRelevantMemories`): selects up to 5
 * pertinent topic memory files for the active user query while excluding
 * already-surfaced paths and suppressing redundant docs for recently used tools.
 */

import { z } from 'zod/v4'
import { safeParseJson } from '../utilities/json.js'
import { extractTextContent } from '../utilities/messages.js'
import { getDefaultSonnetModel } from '../utilities/model/model.js'
import { sideQuery } from '../utilities/side_query.js'
import { formatMemoryManifest, scanMemoryFiles } from './memory_scan.js'

export const MAX_RELEVANT_MEMORIES = 5

export interface RelevantMemory {
  path: string
  mtimeMs: number
}

const SelectMemoriesSchema = z.object({
  selected_memories: z.array(z.string()),
})

const SELECT_MEMORIES_SYSTEM_PROMPT = `You select the most relevant persistent memory files for a user's current coding request.
Return up to ${MAX_RELEVANT_MEMORIES} filenames from the available list that are clearly useful for answering or executing the query.
Be selective and discerning — return an empty list if none are clearly relevant.
If "Recently used tools" is provided, do NOT select routine usage/API reference docs for those tools, but DO still select warnings, gotchas, or known issues about them.
Return JSON matching {"selected_memories": ["filename1.md", ...]}.`

/**
 * Scans `memoryDir`, filters out `alreadySurfaced`, and asks Sonnet via
 * `sideQuery` to pick up to 5 clearly relevant memory files.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal?: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
  queryFn: typeof sideQuery = sideQuery,
): Promise<RelevantMemory[]> {
  if (!query.trim() || signal?.aborted) {
    return []
  }

  const scanned = await scanMemoryFiles(memoryDir, signal)
  const candidates = scanned.filter(m => !alreadySurfaced.has(m.filePath))
  if (candidates.length === 0) {
    return []
  }

  const manifest = formatMemoryManifest(candidates)
  const userContent =
    `Query: ${query}\n\nAvailable memories:\n${manifest}` +
    (recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : '')

  try {
    const response = await queryFn({
      model: getDefaultSonnetModel(),
      skipSystemPromptPrefix: true,
      maxTokens: 256,
      querySource: 'memdir_relevance',
      signal,
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
    })

    const rawText = extractTextContent(response.content).trim()
    const parsed = safeParseJson(rawText)
    const validated = SelectMemoriesSchema.safeParse(parsed)
    if (!validated.success) {
      return []
    }

    const byFilename = new Map(candidates.map(c => [c.filename, c]))
    const results: RelevantMemory[] = []
    const seen = new Set<string>()

    for (const filename of validated.data.selected_memories) {
      if (results.length >= MAX_RELEVANT_MEMORIES) break
      const hit = byFilename.get(filename)
      if (hit && !seen.has(hit.filePath)) {
        seen.add(hit.filePath)
        results.push({ path: hit.filePath, mtimeMs: hit.mtimeMs })
      }
    }

    return results
  } catch {
    return []
  }
}
