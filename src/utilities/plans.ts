/**
 * Plan file slug generation, `~/.copilot/plans/` directory resolution (with
 * project-contained `settings.plansDirectory` traversal protection), reading,
 * and resume/fork plan copying.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { isAbsolute, join, normalize, resolve, sep } from 'path'
import {
  getOriginalCwd,
  getPlanSlugCache,
  getSessionId,
} from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { getPlatform } from './platform.js'
import { getInitialSettings } from './settings/settings.js'

const ADJECTIVES = [
  'amber',
  'brisk',
  'calm',
  'crisp',
  'daring',
  'eager',
  'gentle',
  'lucid',
  'nimble',
  'quiet',
  'steady',
  'swift',
]

const VERBS = [
  'brewing',
  'charting',
  'crafting',
  'forging',
  'gliding',
  'mapping',
  'mending',
  'orbiting',
  'plotting',
  'shaping',
  'tracing',
  'weaving',
]

const NOUNS = [
  'beacon',
  'bridge',
  'canyon',
  'compass',
  'falcon',
  'harbor',
  'lantern',
  'meadow',
  'pebble',
  'river',
  'summit',
  'willow',
]

function pickRandom(list: readonly string[]): string {
  return list[Math.floor(Math.random() * list.length)]!
}

function generatePlanSlug(): string {
  return `${pickRandom(ADJECTIVES)}-${pickRandom(VERBS)}-${pickRandom(NOUNS)}`
}

export function getPlanSlug(sessionId: string = getSessionId()): string {
  const cache = getPlanSlugCache()
  let slug = cache.get(sessionId)
  if (!slug) {
    slug = generatePlanSlug()
    cache.set(sessionId, slug)
  }
  return slug
}

export function setPlanSlug(sessionId: string, slug: string): void {
  getPlanSlugCache().set(sessionId, slug)
}

export function clearPlanSlug(sessionId: string = getSessionId()): void {
  getPlanSlugCache().delete(sessionId)
}

export function clearAllPlanSlugs(): void {
  getPlanSlugCache().clear()
}

function isInsideDir(candidate: string, baseDir: string): boolean {
  const normCand = normalize(resolve(candidate))
  const normBase = normalize(resolve(baseDir))
  const a = getPlatform() === 'windows' ? normCand.toLowerCase() : normCand
  const b = getPlatform() === 'windows' ? normBase.toLowerCase() : normBase
  if (a === b) return true
  const prefix = b.endsWith(sep) ? b : `${b}${sep}`
  return a.startsWith(prefix)
}

/**
 * Resolves the plans directory: respects `settings.plansDirectory` only if
 * it resolves inside the project root (preventing path traversal); otherwise
 * defaults to `~/.copilot/plans`.
 */
export function getPlansDirectory(): string {
  const configured = getInitialSettings().plansDirectory?.trim()
  if (configured) {
    const projectRoot = resolve(getOriginalCwd())
    const resolved = isAbsolute(configured)
      ? resolve(configured)
      : resolve(projectRoot, configured)
    if (isInsideDir(resolved, projectRoot)) {
      mkdirSync(resolved, { recursive: true })
      return resolved
    }
  }
  const defaultDir = join(getClaudeConfigHomeDir(), 'plans')
  mkdirSync(defaultDir, { recursive: true })
  return defaultDir
}

/**
 * Returns the markdown plan file path for the active session (or subagent).
 */
export function getPlanFilePath(agentId?: string): string {
  const dir = getPlansDirectory()
  const slug = getPlanSlug()
  const filename = agentId
    ? `${slug}-agent-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`
    : `${slug}.md`
  return join(dir, filename)
}

/**
 * Reads the current session's plan file, or returns `null` if it does not exist.
 */
export function getPlan(agentId?: string): string | null {
  const filePath = getPlanFilePath(agentId)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

export function copyPlanForResume(
  oldSessionId: string,
  newSessionId: string,
): string | null {
  const oldSlug = getPlanSlugCache().get(oldSessionId)
  if (!oldSlug) return null
  setPlanSlug(newSessionId, oldSlug)
  return join(getPlansDirectory(), `${oldSlug}.md`)
}

export function copyPlanForFork(
  oldSessionId: string,
  newSessionId: string,
): string | null {
  const oldSlug = getPlanSlugCache().get(oldSessionId)
  if (!oldSlug) return null
  const dir = getPlansDirectory()
  const oldPath = join(dir, `${oldSlug}.md`)
  const newSlug = getPlanSlug(newSessionId)
  const newPath = join(dir, `${newSlug}.md`)
  if (existsSync(oldPath) && oldPath !== newPath) {
    copyFileSync(oldPath, newPath)
  }
  return newPath
}
