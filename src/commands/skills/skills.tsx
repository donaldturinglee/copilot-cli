/**
 * `/skills` local-jsx command implementation.
 */

import React from 'react'
import { getCommands } from '../../commands.js'
import { SkillsMenu } from '../../components/skills/skills_menu.js'
import { getCommandRuntime } from '../session_commands.js'
import type {
  LocalJsxCommandContext,
  LocalJsxCommandOnDone,
} from '../../types/command.js'
import { getCwd } from '../../utilities/cwd.js'

/**
 * Mounts `<SkillsMenu />` with all discovered, bundled, plugin, and MCP skills.
 */
export async function call(
  onDone: LocalJsxCommandOnDone,
  context: LocalJsxCommandContext,
): Promise<React.ReactNode> {
  const runtime = getCommandRuntime(context)
  const appState = runtime.getAppState?.()
  const baseCommands =
    runtime.getAllCommands?.() ?? (await getCommands(getCwd()))
  const mcpCommands = appState?.mcp.commands ?? []
  const pluginCommands = appState?.plugins.commands ?? []

  return (
    <SkillsMenu
      commands={[...baseCommands, ...pluginCommands, ...mcpCommands]}
      onCancel={() => onDone()}
    />
  )
}
