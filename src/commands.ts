import { CONTEXT_SECURITY_COMMANDS } from './commands/context_security_commands.js'
import { GIT_DIAGNOSTIC_COMMANDS } from './commands/git_diagnostic_commands.js'
import { MODEL_SETTINGS_COMMANDS } from './commands/model_settings_commands.js'
import {
  BRIDGE_SAFE_COMMANDS,
  filterVisibleCommands,
  findCommandByName,
  isBridgeSafeCommand,
  isRemoteSafeCommand,
  REMOTE_SAFE_COMMANDS,
} from './commands/registry.js'
import { SESSION_COMMANDS } from './commands/session_commands.js'
import type { Command } from './types/command.js'

export {
  BRIDGE_SAFE_COMMANDS,
  filterVisibleCommands,
  findCommandByName,
  isBridgeSafeCommand,
  isRemoteSafeCommand,
  REMOTE_SAFE_COMMANDS,
}

const BUILTIN_COMMANDS: readonly Command[] = [
  ...SESSION_COMMANDS,
  ...MODEL_SETTINGS_COMMANDS,
  ...CONTEXT_SECURITY_COMMANDS,
  ...GIT_DIAGNOSTIC_COMMANDS,
]

let dynamicCommands: Command[] = []

export function registerDynamicCommands(commands: readonly Command[]): void {
  dynamicCommands = [...commands]
}

export function clearDynamicCommands(): void {
  dynamicCommands = []
}

export function getAllCommands(extraCommands?: readonly Command[]): Command[] {
  const seen = new Set<string>()
  const merged: Command[] = []
  for (const cmd of [
    ...BUILTIN_COMMANDS,
    ...dynamicCommands,
    ...(extraCommands ?? []),
  ]) {
    const key = cmd.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(cmd)
  }
  return merged
}

export function getCommandByName(
  name: string,
  extraCommands?: readonly Command[],
): Command | undefined {
  return findCommandByName(name, getAllCommands(extraCommands))
}

export function getRemoteSafeCommands(): Command[] {
  return getAllCommands().filter(cmd => isRemoteSafeCommand(cmd.name))
}

export function getBridgeSafeCommands(): Command[] {
  return getAllCommands().filter(cmd => isBridgeSafeCommand(cmd.name))
}
