/**
 * Acyclic leaf registry exposing `createSkillCommand` and
 * `parseSkillFrontmatterFields` to MCP and Plugin skill loaders without
 * introducing circular module dependencies.
 */

import type { Command } from '../types/command.js'
import type { SettingSource } from '../types/forward.js'
import type { PluginManifest } from '../types/plugin.js'
import type { FrontmatterData } from '../utilities/frontmatter_parser.js'

export interface ParsedSkillFrontmatter {
  displayName?: string
  description: string
  hasUserSpecifiedDescription: boolean
  whenToUse?: string
  argumentHint?: string
  argumentNames?: string[]
  allowedTools?: string[]
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'max' | number
  context?: 'inline' | 'fork'
  agent?: string
  userInvocable: boolean
  disableModelInvocation: boolean
  hooks?: Record<string, unknown[]>
  paths?: string[]
  shell?: 'bash' | 'powershell'
}

export interface CreateSkillCommandParams {
  name: string
  markdownContent: string
  frontmatter: FrontmatterData
  source: SettingSource | 'builtin' | 'mcp' | 'plugin' | 'bundled'
  loadedFrom:
    | 'commands_DEPRECATED'
    | 'skills'
    | 'plugin'
    | 'managed'
    | 'bundled'
    | 'mcp'
  baseDir?: string
  filePath?: string
  pluginInfo?: {
    pluginManifest: PluginManifest
    repository: string
  }
}

export interface McpSkillBuilders {
  parseSkillFrontmatterFields: (
    frontmatter: FrontmatterData,
    markdownBody: string,
    fallbackName: string,
  ) => ParsedSkillFrontmatter
  createSkillCommand: (params: CreateSkillCommandParams) => Command
}

let registeredBuilders: McpSkillBuilders | null = null

/**
 * Registers the skill command factory functions implemented in `load_skills_dir.ts`.
 */
export function registerMcpSkillBuilders(builders: McpSkillBuilders): void {
  registeredBuilders = builders
}

/**
 * Returns the registered skill command factory functions, if initialized.
 */
export function getMcpSkillBuilders(): McpSkillBuilders | null {
  return registeredBuilders
}
