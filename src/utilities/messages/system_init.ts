/**
 * Constructs the initial `system/init` SDK wire message emitted at the start
 * of each headless / programmatic `QueryEngine.submitMessage()` turn.
 */

import { getSdkBetas, getSessionId } from '../../bootstrap/state.js'
import type { Command } from '../../types/command.js'
import type { McpServerConnection, Tool } from '../../types/forward.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { getAnthropicApiKeyWithSource } from '../auth.js'
import { randomUUID } from '../crypto.js'
import type { FastModeState } from '../fast_mode.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SdkSystemInitMessage } from './mappers.js'

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

/**
 * Maps internal tool names to external SDK compatibility names (`Agent` -> `Task`).
 */
export function sdkCompatToolName(name: string): string {
  return name === 'Agent' ? 'Task' : name
}

export interface BuildSystemInitInputs {
  cwd: string
  tools: readonly Tool[]
  mcpClients: readonly McpServerConnection[]
  model: string
  permissionMode: PermissionMode
  commands: readonly Command[]
  agents?: ReadonlyArray<{ agentType?: string; name?: string }>
  skills?: readonly string[]
  plugins?: readonly LoadedPlugin[]
  fastModeState?: FastModeState
}

/**
 * Builds the `system/init` SDK handshake message.
 */
export function buildSystemInitMessage(
  inputs: BuildSystemInitInputs,
): SdkSystemInitMessage {
  const apiKeySource = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  }).source
  const betas = getSdkBetas()
  const outputStyle = getInitialSettings().outputStyle ?? 'default'

  const slashCommands = inputs.commands.map(cmd => cmd.name)
  const agentNames = inputs.agents
    ?.map(agent => agent.agentType ?? agent.name)
    .filter((name): name is string => Boolean(name))

  return {
    type: 'system',
    subtype: 'init',
    cwd: inputs.cwd,
    session_id: getSessionId(),
    tools: inputs.tools.map(t => sdkCompatToolName(t.name)),
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    slash_commands: slashCommands,
    apiKeySource,
    ...(betas && betas.length > 0 ? { betas: [...betas] } : {}),
    claude_code_version: getMacroVersion(),
    output_style: outputStyle,
    ...(agentNames && agentNames.length > 0 ? { agents: agentNames } : {}),
    skills: inputs.skills ? [...inputs.skills] : [],
    plugins: (inputs.plugins ?? []).map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      ...(plugin.source ? { source: plugin.source } : {}),
    })),
    ...(inputs.fastModeState ? { fast_mode_state: inputs.fastModeState } : {}),
    uuid: randomUUID(),
  }
}
