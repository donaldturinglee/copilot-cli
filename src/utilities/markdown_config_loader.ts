import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, extname, join, relative, resolve } from 'path'
import type { SettingSource } from '../types/forward.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import {
  type FrontmatterData,
  parseFrontmatter,
} from './frontmatter_parser.js'
import { parseToolListFromCli } from './permissions/permission_setup.js'
import { getManagedFilePath } from './settings/managed_path.js'

export type LoadedMarkdownConfig = {
  id: string
  filePath: string
  frontmatter: FrontmatterData
  content: string
}

export interface ScopedMarkdownFile {
  filePath: string
  baseDir: string
  relativePath: string
  frontmatter: FrontmatterData
  content: string
  source: SettingSource
}

/**
 * Extracts a single-line fallback description from the first non-heading line
 * of a Markdown body (truncated to 100 chars).
 */
export function extractDescriptionFromMarkdown(
  content: string,
  fallbackLabel = 'Skill',
): string {
  for (const rawLine of content.split(/\r?\n/)) {
    const cleaned = rawLine.replace(/^#+\s*/, '').trim()
    if (cleaned.length > 0) {
      return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned
    }
  }
  return fallbackLabel
}

/**
 * Parses `allowed-tools` from YAML frontmatter (`string` or `string[]`) into a
 * normalized tool rule list.
 */
export function parseSlashCommandToolsFromFrontmatter(
  toolsValue: string | string[] | null | undefined,
): string[] {
  if (!toolsValue) {
    return []
  }
  const list = Array.isArray(toolsValue) ? toolsValue : [toolsValue]
  const parsed = parseToolListFromCli(list)
  if (parsed.includes('*')) {
    return ['*']
  }
  return parsed
}

/**
 * Walks upward from `cwd` toward `homedir()`, collecting existing
 * `.copilot/<subdir>` directories ordered deepest (`cwd`) to shallowest.
 */
export function getProjectDirsUpToHome(
  subdir: string,
  cwd: string,
): string[] {
  const home = resolve(homedir())
  const dirs: string[] = []
  let current = resolve(cwd)

  while (current !== home) {
    const candidate = join(current, '.copilot', subdir)
    if (existsSync(candidate)) {
      dirs.push(candidate)
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return dirs
}

function walkMarkdownRecursive(
  rootDir: string,
  currentDir: string,
  source: SettingSource,
  seenRealpaths: Set<string>,
  results: ScopedMarkdownFile[],
): void {
  if (!existsSync(currentDir)) {
    return
  }
  let entries
  try {
    entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    let resolvedPath = fullPath
    try {
      resolvedPath = realpathSync(fullPath)
    } catch {
      continue
    }
    const dedupKey =
      process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath

    if (entry.isDirectory()) {
      if (seenRealpaths.has(`dir:${dedupKey}`)) {
        continue
      }
      seenRealpaths.add(`dir:${dedupKey}`)
      walkMarkdownRecursive(rootDir, fullPath, source, seenRealpaths, results)
      continue
    }

    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      extname(entry.name).toLowerCase() === '.md'
    ) {
      if (seenRealpaths.has(`file:${dedupKey}`)) {
        continue
      }
      seenRealpaths.add(`file:${dedupKey}`)
      try {
        const raw = readFileSync(fullPath, 'utf8')
        const parsed = parseFrontmatter(raw, fullPath)
        results.push({
          filePath: fullPath,
          baseDir: rootDir,
          relativePath: relative(rootDir, fullPath).replace(/\\/g, '/'),
          frontmatter: parsed.frontmatter,
          content: parsed.content.trim(),
          source,
        })
      } catch {
        // Ignore unreadable markdown files
      }
    }
  }
}

/**
 * Loads `.md` files recursively across managed, user (`~/.copilot/<subdir>`),
 * and project (`.copilot/<subdir>`) directories with `realpath` deduplication.
 */
export function loadMarkdownFilesForSubdir(
  subdir: string,
  cwd: string,
): ScopedMarkdownFile[] {
  const seenRealpaths = new Set<string>()
  const results: ScopedMarkdownFile[] = []

  const managedDir = join(getManagedFilePath(), '.copilot', subdir)
  walkMarkdownRecursive(
    managedDir,
    managedDir,
    'policySettings',
    seenRealpaths,
    results,
  )

  const userDir = join(getClaudeConfigHomeDir(), subdir)
  walkMarkdownRecursive(
    userDir,
    userDir,
    'userSettings',
    seenRealpaths,
    results,
  )

  for (const projDir of getProjectDirsUpToHome(subdir, cwd)) {
    walkMarkdownRecursive(
      projDir,
      projDir,
      'projectSettings',
      seenRealpaths,
      results,
    )
  }

  return results
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
