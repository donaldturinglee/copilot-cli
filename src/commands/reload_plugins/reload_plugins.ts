/**
 * `/reload-plugins` slash command implementation.
 */

import { getCommandRuntime } from '../session_commands.js'
import type {
  LocalCommandResult,
  LocalJsxCommandContext,
} from '../../types/command.js'
import { refreshActivePlugins } from '../../utilities/plugins/refresh.js'

/**
 * Reloads all active plugins and their 7 component surfaces in-place.
 */
export async function call(
  _args: string,
  context: LocalJsxCommandContext,
): Promise<LocalCommandResult> {
  const runtime = getCommandRuntime(context)
  const summary = await refreshActivePlugins(runtime.setAppState)
  const parts = [
    `${summary.enabled.length} active plugin(s)`,
    `${summary.commands.length} skill(s)/command(s)`,
    `${summary.agentCount} agent(s)`,
    `${summary.hookMatcherCount} hook matcher(s)`,
    `${summary.mcpServerCount} MCP server(s)`,
    `${summary.lspServerCount} LSP server(s)`,
  ]
  const errorSuffix =
    summary.errors.length > 0 ? ` (${summary.errors.length} error(s))` : ''
  return {
    type: 'text',
    value: `Reloaded plugins: ${parts.join(', ')}${errorSuffix}.`,
  }
}
