/**
 * Topic memory directory scanner (`scanMemoryFiles`) and manifest formatter
 * (`formatMemoryManifest`): reads the first 30 lines of up to 200 `.md` files
 * (excluding `MEMORY.md`), parses frontmatter (`description`, `type`), and
 * sorts newest-first.
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utilities/frontmatter_parser.js'
import { readFileInRange } from '../utilities/read_file_in_range.js'
import { parseMemoryType, type TopicMemoryType } from './memory_types.js'

export const MAX_MEMORY_FILES = 200
export const FRONTMATTER_MAX_LINES = 30

export interface MemoryHeader {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: TopicMemoryType | undefined
}

/**
 * Scans `memoryDir` recursively for `.md` topic files (excluding `MEMORY.md`),
 * parsing frontmatter headers from the first 30 lines and sorting newest-first.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal?: AbortSignal,
): Promise<MemoryHeader[]> {
  if (signal?.aborted) {
    return []
  }

  let entries: string[]
  try {
    const raw = await readdir(memoryDir, { recursive: true })
    entries = raw.map(item => String(item))
  } catch {
    return []
  }

  const mdFiles = entries.filter(
    rel =>
      rel.toLowerCase().endsWith('.md') &&
      basename(rel).toUpperCase() !== 'MEMORY.MD',
  )

  const settled = await Promise.allSettled(
    mdFiles.map(async (relPath): Promise<MemoryHeader | null> => {
      if (signal?.aborted) return null
      const filePath = join(memoryDir, relPath)
      const res = await readFileInRange(filePath, {
        offset: 1,
        limit: FRONTMATTER_MAX_LINES,
      })
      const { frontmatter } = parseFrontmatter(res.content)
      const description =
        typeof frontmatter.description === 'string' &&
        frontmatter.description.trim().length > 0
          ? frontmatter.description.trim()
          : null
      const type = parseMemoryType(frontmatter.type)
      return {
        filename: relPath.replace(/\\/g, '/'),
        filePath,
        mtimeMs: res.mtimeMs,
        description,
        type,
      }
    }),
  )

  const headers: MemoryHeader[] = []
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled' && outcome.value !== null) {
      headers.push(outcome.value)
    }
  }

  headers.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return headers.slice(0, MAX_MEMORY_FILES)
}

/**
 * Formats scanned memory headers into a concise manifest for LLM selection
 * and extraction prompts.
 */
export function formatMemoryManifest(
  memories: readonly MemoryHeader[],
): string {
  return memories
    .map(m => {
      const typePrefix = m.type ? `[${m.type}] ` : ''
      const iso = new Date(m.mtimeMs).toISOString()
      const desc = m.description ? `: ${m.description}` : ''
      return `- ${typePrefix}${m.filename} (${iso})${desc}`
    })
    .join('\n')
}
