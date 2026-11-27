import { existsSync, readdirSync, readFileSync } from 'fs'
import { basename, extname, join } from 'path'
import {
  type FrontmatterData,
  parseFrontmatter,
} from './frontmatter_parser.js'

export type LoadedMarkdownConfig = {
  id: string
  filePath: string
  frontmatter: FrontmatterData
  content: string
}

/**
 * Load all `.md` configuration files from a directory, extracting YAML
 * frontmatter and markdown body cleanly.
 */
export function loadMarkdownConfigDir(dirPath: string): LoadedMarkdownConfig[] {
  if (!existsSync(dirPath)) return []
  let entries: string[]
  try {
    entries = readdirSync(dirPath).sort()
  } catch {
    return []
  }

  const results: LoadedMarkdownConfig[] = []
  for (const name of entries) {
    if (extname(name).toLowerCase() !== '.md') continue
    const filePath = join(dirPath, name)
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = parseFrontmatter(raw, filePath)
      const id = basename(name, extname(name))
      results.push({
        id,
        filePath,
        frontmatter: parsed.frontmatter,
        content: parsed.content.trim(),
      })
    } catch {
      // Skip unreadable markdown files
    }
  }
  return results
}
