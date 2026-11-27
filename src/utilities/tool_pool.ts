/**
 * Tool pool partition sorting, deduplication, and mode-specific filtering.
 *
 * CRITICAL PROMPT-CACHE INVARIANT:
 * Built-in tools and MCP tools are sorted **separately** so adding or removing
 * MCP tools never shifts the ordering of the built-in tool prefix!
 */

import uniqBy from 'lodash-es/uniqBy.js'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import type { AnyTool, Tools } from '../tool.js'
import type { ToolPermissionContext } from '../types/permissions.js'
import type { DeepImmutable } from '../types/utils.js'
import { getDenyRuleForTool } from './permissions/rule_matching.js'

const PR_ACTIVITY_SUBSCRIPTION_TOOL_NAMES = new Set([
  'SubscribePR',
  'SubscribePr',
  'UnsubscribePR',
])

/**
 * Identifies PR activity subscription helper tools.
 */
export function isPrActivitySubscriptionTool(tool: {
  readonly name: string
}): boolean {
  return PR_ACTIVITY_SUBSCRIPTION_TOOL_NAMES.has(tool.name)
}

/**
 * Filters a tool pool down to coordinator-safe tools when coordinator mode is
 * active.
 */
export function applyCoordinatorToolFilter(
  tools: Tools,
  isCoordinatorMode: boolean,
): AnyTool[] {
  if (!isCoordinatorMode) {
    return [...tools]
  }
  return tools.filter(
    tool => tool.isMcp === true || COORDINATOR_MODE_ALLOWED_TOOLS.has(tool.name),
  )
}

function compareToolNames(a: AnyTool, b: AnyTool): number {
  return a.name.localeCompare(b.name)
}

/**
 * Partition-sorts built-in tools and MCP tools separately, then deduplicates
 * by `name` with built-in tools taking precedence over colliding MCP names.
 */
export function sortAndDeduplicateToolPool(
  builtInTools: Tools,
  mcpTools: Tools,
): AnyTool[] {
  const sortedBuiltIn = [...builtInTools].sort(compareToolNames)
  const sortedMcp = [...mcpTools].sort(compareToolNames)
  return uniqBy([...sortedBuiltIn, ...sortedMcp], tool => tool.name)
}

/**
 * Filters out tools blocked by blanket deny rules in `permissionContext`.
 */
export function filterToolsByPermissionDenyRules(
  tools: Tools,
  permissionContext: DeepImmutable<ToolPermissionContext>,
): AnyTool[] {
  return tools.filter(
    tool => getDenyRuleForTool(permissionContext, tool) === undefined,
  )
}

/**
 * Merges built-in and MCP tools while enforcing deny rules, optional
 * coordinator filtering, and cache-stable partition sorting.
 */
export function mergeAndFilterTools(
  builtInTools: Tools,
  mcpTools: Tools,
  permissionContext: DeepImmutable<ToolPermissionContext>,
  options?: { isCoordinatorMode?: boolean },
): AnyTool[] {
  const filteredBuiltIn = filterToolsByPermissionDenyRules(
    builtInTools,
    permissionContext,
  )
  const filteredMcp = filterToolsByPermissionDenyRules(
    mcpTools,
    permissionContext,
  )
  const merged = sortAndDeduplicateToolPool(filteredBuiltIn, filteredMcp)
  return applyCoordinatorToolFilter(
    merged,
    Boolean(options?.isCoordinatorMode),
  )
}
