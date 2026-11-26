/**
 * Subagent model resolution with `COPILOT_CLI_SUBAGENT_MODEL` override,
 * Bedrock cross-region prefix inheritance, and tier inheritance.
 */

import type { PermissionMode } from '../../types/permissions.js'
import { isModelFamilyAlias, MODEL_ALIASES } from './aliases.js'
import {
  applyBedrockRegionPrefix,
  getBedrockRegionPrefix,
} from './bedrock.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getApiProvider } from './providers.js'

export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const

export type AgentModelOption = (typeof AGENT_MODEL_OPTIONS)[number]

/**
 * Resolves the concrete model ID for a subagent call.
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: string,
  permissionMode: PermissionMode = 'default',
): string {
  const envSubagentModel = process.env.COPILOT_CLI_SUBAGENT_MODEL
  const rawSpec = envSubagentModel || toolSpecifiedModel || agentModel

  if (!rawSpec || rawSpec.toLowerCase() === 'inherit') {
    return getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: parentModel,
    })
  }

  const lowerSpec = rawSpec.trim().toLowerCase()

  // Bare family alias matching the parent's model family inherits the exact parent model
  if (isModelFamilyAlias(lowerSpec)) {
    const parentCanonical = getCanonicalName(parentModel)
    if (parentCanonical.includes(lowerSpec)) {
      return parentModel
    }
  }

  let resolved = parseUserSpecifiedModel(rawSpec)

  // On Bedrock, inherit parent cross-region prefix unless resolved already has one
  if (getApiProvider() === 'bedrock') {
    const parentPrefix = getBedrockRegionPrefix(parentModel)
    const resolvedPrefix = getBedrockRegionPrefix(resolved)
    if (parentPrefix && !resolvedPrefix) {
      resolved = applyBedrockRegionPrefix(resolved, parentPrefix)
    }
  }

  return resolved
}
