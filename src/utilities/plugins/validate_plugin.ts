/**
 * `plugin.json`, `marketplace.json`, and component frontmatter validator
 * powering `copilot plugin validate <path>` and `/plugin validate`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { parseFrontmatter } from '../frontmatter_parser.js'
import {
  findMarketplaceManifestPath,
  findPluginManifestPath,
  resolvePathWithinPlugin,
} from './plugin_directories.js'
import { validateOfficialNameSource } from './official_marketplace.js'
import {
  PluginHooksSchema,
  PluginManifestSchema,
  PluginMarketplaceSchema,
} from './schemas.js'

const MARKETPLACE_ONLY_FIELDS = new Set([
  'category',
  'source',
  'tags',
  'strict',
  'id',
])

export interface ValidationReport {
  valid: boolean
  kind: 'plugin' | 'marketplace' | 'unknown'
  path: string
  name?: string
  errors: string[]
  warnings: string[]
}

function scanForParentTraversal(value: unknown, trail = ''): string[] {
  const hits: string[] = []
  if (typeof value === 'string') {
    if (value.includes('../') || value.includes('..\\') || value === '..') {
      hits.push(
        `Path traversal ".." is not allowed at ${trail || 'root'}: "${value}"`,
      )
    }
    return hits
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      hits.push(...scanForParentTraversal(item, `${trail}[${idx}]`))
    })
    return hits
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      hits.push(...scanForParentTraversal(v, trail ? `${trail}.${k}` : k))
    }
  }
  return hits
}

/**
 * Validates Markdown frontmatter and `hooks/hooks.json` inside `pluginDir`.
 */
export function validatePluginContents(pluginDir: string): {
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []

  const skillsDir = join(pluginDir, 'skills')
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillMd = join(skillsDir, entry.name, 'SKILL.md')
        if (!existsSync(skillMd)) {
          warnings.push(`Skill directory "${entry.name}" has no SKILL.md`)
          continue
        }
        const parsed = parseFrontmatter(readFileSync(skillMd, 'utf8'), skillMd)
        if (
          parsed.frontmatter.shell &&
          parsed.frontmatter.shell !== 'bash' &&
          parsed.frontmatter.shell !== 'powershell'
        ) {
          errors.push(
            `Invalid shell "${String(parsed.frontmatter.shell)}" in ${skillMd}`,
          )
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  const agentsDir = join(pluginDir, 'agents')
  if (existsSync(agentsDir)) {
    try {
      for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const agentMd = join(agentsDir, entry.name)
        const parsed = parseFrontmatter(readFileSync(agentMd, 'utf8'), agentMd)
        if (!parsed.frontmatter.description) {
          warnings.push(`Agent "${entry.name}" is missing frontmatter description`)
        }
      }
    } catch {
      // Ignore
    }
  }

  const hooksJsonPath = join(pluginDir, 'hooks', 'hooks.json')
  if (existsSync(hooksJsonPath)) {
    try {
      const rawHooks: unknown = JSON.parse(readFileSync(hooksJsonPath, 'utf8'))
      const parsed = PluginHooksSchema().safeParse(rawHooks)
      if (!parsed.success) {
        errors.push(`hooks/hooks.json invalid: ${parsed.error.message}`)
      }
    } catch (error) {
      errors.push(
        `hooks/hooks.json parse error: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { errors, warnings }
}

/**
 * Validates a plugin or marketplace manifest file or directory at `targetPath`.
 */
export function validateManifest(targetPath: string): ValidationReport {
  const resolved = resolve(targetPath)
  if (!existsSync(resolved)) {
    return {
      valid: false,
      kind: 'unknown',
      path: resolved,
      errors: [`Path does not exist: ${resolved}`],
      warnings: [],
    }
  }

  const stats = statSync(resolved)
  let manifestFile = resolved
  let rootDir = resolved

  if (stats.isDirectory()) {
    const mpManifest = findMarketplaceManifestPath(resolved)
    const plugManifest = findPluginManifestPath(resolved)
    if (mpManifest && !plugManifest) {
      manifestFile = mpManifest
    } else if (plugManifest) {
      manifestFile = plugManifest
    } else {
      return {
        valid: false,
        kind: 'unknown',
        path: resolved,
        errors: [
          `No plugin.json or marketplace.json found in ${resolved} (expected under .copilot-plugin/ or .claude-plugin/)`,
        ],
        warnings: [],
      }
    }
  } else {
    rootDir = resolve(resolved, '..')
    if (
      rootDir.endsWith('.copilot-plugin') ||
      rootDir.endsWith('.claude-plugin')
    ) {
      rootDir = resolve(rootDir, '..')
    }
  }

  let parsed: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        valid: false,
        kind: 'unknown',
        path: manifestFile,
        errors: ['Manifest root must be a JSON object'],
        warnings: [],
      }
    }
    parsed = raw as Record<string, unknown>
  } catch (error) {
    return {
      valid: false,
      kind: 'unknown',
      path: manifestFile,
      errors: [
        `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings: [],
    }
  }

  const isMarketplace =
    manifestFile.toLowerCase().endsWith('marketplace.json') ||
    Array.isArray(parsed.plugins)

  if (isMarketplace) {
    const errors = scanForParentTraversal(parsed)
    const warnings: string[] = []
    const res = PluginMarketplaceSchema().safeParse(parsed)
    if (!res.success) {
      errors.push(res.error.message)
      return {
        valid: false,
        kind: 'marketplace',
        path: manifestFile,
        errors,
        warnings,
      }
    }

    const seenNames = new Set<string>()
    const pluginRootPrefix = res.data.metadata?.pluginRoot ?? '.'
    for (const entry of res.data.plugins) {
      if (seenNames.has(entry.name)) {
        errors.push(`Duplicate plugin name in marketplace: "${entry.name}"`)
      }
      seenNames.add(entry.name)

      if (typeof entry.source === 'string') {
        const base = resolve(rootDir, pluginRootPrefix)
        const localDir = resolvePathWithinPlugin(base, entry.source)
        if (!localDir || !existsSync(localDir)) {
          errors.push(
            `Local plugin source "${entry.source}" for "${entry.name}" does not exist`,
          )
        } else {
          const contentReport = validatePluginContents(localDir)
          errors.push(...contentReport.errors)
          warnings.push(...contentReport.warnings)
        }
      } else {
        const officialCheck = validateOfficialNameSource(
          res.data.name,
          entry.source,
        )
        if (!officialCheck.valid && res.data.name === 'claude-plugins-official') {
          warnings.push(officialCheck.reason ?? 'Source warning')
        }
      }
    }

    return {
      valid: errors.length === 0,
      kind: 'marketplace',
      path: manifestFile,
      name: res.data.name,
      errors,
      warnings,
    }
  }

  // Plugin manifest validation
  const errors = scanForParentTraversal(parsed)
  const warnings: string[] = []
  const cleanedManifest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (MARKETPLACE_ONLY_FIELDS.has(k)) {
      warnings.push(
        `Marketplace-only field "${k}" in plugin.json is ignored outside marketplace.json`,
      )
      continue
    }
    cleanedManifest[k] = v
  }

  const strictRes = PluginManifestSchema().strict().safeParse(cleanedManifest)
  if (!strictRes.success) {
    errors.push(strictRes.error.message)
    return {
      valid: false,
      kind: 'plugin',
      path: manifestFile,
      errors,
      warnings,
    }
  }

  const contentCheck = validatePluginContents(rootDir)
  errors.push(...contentCheck.errors)
  warnings.push(...contentCheck.warnings)

  return {
    valid: errors.length === 0,
    kind: 'plugin',
    path: manifestFile,
    name: strictRes.data.name,
    errors,
    warnings,
  }
}
