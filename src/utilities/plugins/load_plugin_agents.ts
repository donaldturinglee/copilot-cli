/**
 * Component Loader #3: Loads custom Agent definitions (`agents/*.md`) from
 * enabled plugins while stripping privileged fields (`permissionMode`, `hooks`,
 * `mcpServers`) that untrusted plugin agent markdown must never escalate.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, extname, join } from 'path'
import type { LoadedPlugin } from '../../types/plugin.js'
import { parseEffortValue } from '../effort.js'
import {
  parseBooleanFrontmatter,
  parseFrontmatter,
  parsePositiveIntFromFrontmatter,
} from '../frontmatter_parser.js'
import { extractDescriptionFromMarkdown } from '../markdown_config_loader.js'
import { loadAllPluginsCacheOnly } from './plugin_loader.js'
import {
  loadPluginOptions,
  substitutePluginRootAndData,
  substituteUserConfigInContent,
} from './plugin_options_storage.js'
import type { PluginUserConfigOption } from './schemas.js'

export interface PluginAgentDefinition {
  agentType: string
  name: string
  description: string
  systemPrompt: string
  pluginSource: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  color?: string
  model?: string
  background?: boolean
  memory?: 'user' | 'project' | 'local'
  isolation?: 'worktree'
  effort?: 'low' | 'medium' | 'high' | 'max' | number
  maxTurns?: number
}

let cachedPluginAgents: PluginAgentDefinition[] | null = null

export function clearPluginAgentCache(): void {
  cachedPluginAgents = null
}

function collectMarkdownFiles(targetPath: string): string[] {
  if (!existsSync(targetPath)) {
    return []
  }
  const st = statSync(targetPath)
  if (st.isFile() && extname(targetPath).toLowerCase() === '.md') {
    return [targetPath]
  }
  if (!st.isDirectory()) {
    return []
  }
  const files: string[] = []
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const full = join(targetPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectMarkdownFiles(full))
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(full)
    }
  }
  return files
}

function toStringList(raw: unknown): string[] | undefined {
  if (!raw) return undefined
  if (Array.isArray(raw)) {
    const items = raw.map(v => String(v).trim()).filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (typeof raw === 'string') {
    const items = raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  return undefined
}

/**
 * Loads namespaced `PluginAgentDefinition[]` across enabled plugins.
 */
export async function loadPluginAgents(
  pluginsOverride?: readonly LoadedPlugin[],
): Promise<PluginAgentDefinition[]> {
  if (!pluginsOverride && cachedPluginAgents) {
    return cachedPluginAgents
  }

  const enabled = pluginsOverride ?? (await loadAllPluginsCacheOnly()).enabled
  const agents: PluginAgentDefinition[] = []

  for (const plugin of enabled) {
    if (plugin.isBuiltin) continue
    const userOptions = loadPluginOptions(plugin.source)
    const userSchema = plugin.manifest.userConfig as
      | Record<string, PluginUserConfigOption>
      | undefined

    for (const agentPath of plugin.agentsPaths ?? []) {
      for (const filePath of collectMarkdownFiles(agentPath)) {
        try {
          const parsed = parseFrontmatter(
            readFileSync(filePath, 'utf8'),
            filePath,
          )
          const fm = parsed.frontmatter
          const rawName =
            typeof fm.name === 'string' && fm.name.trim()
              ? fm.name.trim()
              : basename(filePath, extname(filePath))
          const qualifiedName = rawName.includes(':')
            ? rawName
            : `${plugin.name}:${rawName}`
          const description =
            typeof fm.description === 'string' && fm.description.trim()
              ? fm.description.trim()
              : extractDescriptionFromMarkdown(parsed.content, 'Plugin agent')

          const substitutedBody = substituteUserConfigInContent(
            substitutePluginRootAndData(
              parsed.content.trim(),
              plugin.path,
              plugin.source,
            ),
            userOptions,
            userSchema,
          )

          const rawModel =
            typeof fm.model === 'string' &&
            fm.model.trim() &&
            fm.model.trim().toLowerCase() !== 'inherit'
              ? fm.model.trim()
              : undefined
          const rawMemory = fm.memory
          const memory =
            rawMemory === 'user' ||
            rawMemory === 'project' ||
            rawMemory === 'local'
              ? rawMemory
              : undefined

          // Security: `permissionMode`, `hooks`, and `mcpServers` are intentionally
          // ignored on plugin-supplied agent markdown files.
          agents.push({
            agentType: qualifiedName,
            name: qualifiedName,
            description,
            systemPrompt: substitutedBody,
            pluginSource: plugin.source,
            tools: toStringList(fm.tools),
            disallowedTools: toStringList(fm.disallowedTools),
            skills: toStringList(fm.skills),
            ...(typeof fm.color === 'string' ? { color: fm.color } : {}),
            ...(rawModel ? { model: rawModel } : {}),
            ...(fm.background !== undefined
              ? { background: parseBooleanFrontmatter(fm.background) }
              : {}),
            ...(memory ? { memory } : {}),
            ...(fm.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
            ...(fm.effort !== undefined && fm.effort !== null
              ? { effort: parseEffortValue(String(fm.effort)) }
              : {}),
            ...(parsePositiveIntFromFrontmatter(fm.maxTurns) !== undefined
              ? { maxTurns: parsePositiveIntFromFrontmatter(fm.maxTurns) }
              : {}),
          })
        } catch {
          // Skip malformed agent markdown
        }
      }
    }
  }

  if (!pluginsOverride) {
    cachedPluginAgents = agents
  }
  return agents
}
