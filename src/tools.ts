/**
 * Built-in tool registry, preset parsing, deny-rule filtering, and
 * cache-stable `assembleToolPool()` assembly.
 *
 * Prompt-Cache Invariant:
 * Built-in tools and MCP tools are sorted **separately** so adding or removing
 * MCP tools never shifts the ordering of the built-in tool prefix.
 */

import {
  BASH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
} from './constants/tools.js'
import { type AnyTool, asAnyTool, toolMatchesName, type Tools } from './tool.js'
import { AskUserQuestionTool } from './tools/ask_user_question_tool/ask_user_question_tool.js'
import { BashTool } from './tools/bash_tool/bash_tool.js'
import { BriefTool } from './tools/brief_tool/brief_tool.js'
import { ConfigTool } from './tools/config_tool/config_tool.js'
import { EnterPlanModeTool } from './tools/enter_plan_mode_tool/enter_plan_mode_tool.js'
import { EnterWorktreeTool } from './tools/enter_worktree_tool/enter_worktree_tool.js'
import { ExitPlanModeV2Tool } from './tools/exit_plan_mode_tool/exit_plan_mode_v2_tool.js'
import { ExitWorktreeTool } from './tools/exit_worktree_tool/exit_worktree_tool.js'
import { FileEditTool } from './tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from './tools/file_read_tool/file_read_tool.js'
import { FileWriteTool } from './tools/file_write_tool/file_write_tool.js'
import { GlobTool } from './tools/glob_tool/glob_tool.js'
import { GrepTool } from './tools/grep_tool/grep_tool.js'
import { NotebookEditTool } from './tools/notebook_edit_tool/notebook_edit_tool.js'
import { PowerShellTool } from './tools/power_shell_tool/power_shell_tool.js'
import { TodoWriteTool } from './tools/todo_write_tool/todo_write_tool.js'
import { ToolSearchTool } from './tools/tool_search_tool/tool_search_tool.js'
import { WebFetchTool } from './tools/web_fetch_tool/web_fetch_tool.js'
import { WebSearchTool } from './tools/web_search_tool/web_search_tool.js'
import type { ToolPermissionContext } from './types/permissions.js'
import type { DeepImmutable } from './types/utils.js'
import { isEnvTruthy } from './utilities/env_utils.js'
import {
  filterToolsByPermissionDenyRules,
  mergeAndFilterTools,
  sortAndDeduplicateToolPool,
} from './utilities/tool_pool.js'

export const TOOL_PRESETS = ['default'] as const
export type ToolPresetName = (typeof TOOL_PRESETS)[number]

const SIMPLE_MODE_TOOL_NAMES = new Set<string>([
  BASH_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
])

const DEFAULT_BUILT_IN_TOOLS: AnyTool[] = [
  asAnyTool(FileReadTool),
  asAnyTool(FileEditTool),
  asAnyTool(FileWriteTool),
  asAnyTool(NotebookEditTool),
  asAnyTool(GlobTool),
  asAnyTool(GrepTool),
  asAnyTool(BashTool),
  asAnyTool(PowerShellTool),
  asAnyTool(ToolSearchTool),
  asAnyTool(WebFetchTool),
  asAnyTool(WebSearchTool),
  asAnyTool(EnterPlanModeTool),
  asAnyTool(ExitPlanModeV2Tool),
  asAnyTool(EnterWorktreeTool),
  asAnyTool(ExitWorktreeTool),
  asAnyTool(AskUserQuestionTool),
  asAnyTool(TodoWriteTool),
  asAnyTool(BriefTool),
  asAnyTool(ConfigTool),
]

let builtInToolsOverride: AnyTool[] | null = null

/**
 * Overrides the built-in tool registry (pass `null` to restore defaults).
 */
export function registerBuiltInTools(tools: Tools | null): void {
  builtInToolsOverride = tools ? [...tools] : null
}

/**
 * Parses a `--tools` preset token (`'default'`) or returns `null` if it is a
 * literal tool name rather than a named preset.
 */
export function parseToolPreset(token: string): ToolPresetName | null {
  const normalized = token.trim().toLowerCase()
  if ((TOOL_PRESETS as readonly string[]).includes(normalized)) {
    return normalized as ToolPresetName
  }
  return null
}

/**
 * Returns all built-in tools regardless of `isEnabled()` status.
 */
export function getAllBaseTools(): AnyTool[] {
  return [...(builtInToolsOverride ?? DEFAULT_BUILT_IN_TOOLS)]
}

/**
 * Returns the default preset tool list.
 */
export function getToolsForDefaultPreset(): AnyTool[] {
  return getAllBaseTools()
}

/**
 * Filters out any tool matched by a blanket deny rule in `permissionContext`.
 */
export function filterToolsByDenyRules(
  tools: Tools,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): AnyTool[] {
  return filterToolsByPermissionDenyRules(tools, permissionContext)
}

/**
 * Returns the enabled built-in tools filtered by `COPILOT_CLI_SIMPLE` mode,
 * `tool.isEnabled()`, optional `--tools` allowlist, and `permissionContext`
 * deny rules.
 */
export function getTools(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  options?: {
    allowedToolNames?: readonly string[]
    baseTools?: Tools
  },
): AnyTool[] {
  let pool = options?.baseTools ? [...options.baseTools] : getAllBaseTools()

  if (isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)) {
    pool = pool.filter(tool => SIMPLE_MODE_TOOL_NAMES.has(tool.name))
  }

  if (options?.allowedToolNames !== undefined) {
    const requested = options.allowedToolNames.filter(s => s.trim().length > 0)
    if (requested.length === 0) {
      return []
    }
    const includesDefault = requested.some(t => parseToolPreset(t) === 'default')
    if (!includesDefault) {
      pool = pool.filter(tool =>
        requested.some(name => toolMatchesName(tool, name)),
      )
    }
  }

  const enabled = pool.filter(tool => tool.isEnabled())
  return filterToolsByDenyRules(enabled, permissionContext)
}

/**
 * Assembles the final model-facing tool pool by combining built-in tools and
 * MCP tools while preserving prompt-cache prefix stability:
 * 1. Filters both partitions through `permissionContext` deny rules.
 * 2. Sorts built-in tools alphabetically in their own partition.
 * 3. Sorts MCP tools alphabetically in a separate trailing partition.
 * 4. Deduplicates by `name` so built-in tools take precedence over MCP collisions.
 */
export function assembleToolPool(
  permissionContext: DeepImmutable<ToolPermissionContext>,
  mcpTools: Tools = [],
  options?: {
    allowedToolNames?: readonly string[]
    baseTools?: Tools
    isCoordinatorMode?: boolean
  },
): AnyTool[] {
  const builtIn = getTools(permissionContext, {
    allowedToolNames: options?.allowedToolNames,
    baseTools: options?.baseTools,
  })
  return mergeAndFilterTools(builtIn, mcpTools, permissionContext, {
    isCoordinatorMode: options?.isCoordinatorMode,
  })
}

/**
 * Merges an already-filtered built-in tool list with MCP tools using separate
 * partition sorting and deduplication.
 */
export function getMergedTools(builtInTools: Tools, mcpTools: Tools): AnyTool[] {
  return sortAndDeduplicateToolPool(builtInTools, mcpTools)
}
