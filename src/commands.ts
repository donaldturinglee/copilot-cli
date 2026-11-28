import { CONTEXT_SECURITY_COMMANDS } from './commands/context_security_commands.js'
import { GIT_DIAGNOSTIC_COMMANDS } from './commands/git_diagnostic_commands.js'
import { mcpSlashCommand } from './commands/mcp/index.js'
import { MODEL_SETTINGS_COMMANDS } from './commands/model_settings_commands.js'
import { pluginSlashCommand } from './commands/plugin/index.js'
import {
  BRIDGE_SAFE_COMMANDS,
  filterVisibleCommands,
  findCommandByName,
  isBridgeSafeCommand,
  isRemoteSafeCommand,
  REMOTE_SAFE_COMMANDS,
} from './commands/registry.js'
import { reloadPluginsSlashCommand } from './commands/reload_plugins/index.js'
import { SESSION_COMMANDS } from './commands/session_commands.js'
import { skillsSlashCommand } from './commands/skills/index.js'
import {
  getBundledSkillCommands,
  initBundledSkills,
} from './skills/bundled/index.js'
import {
  clearSkillCaches,
  getSkillDirCommands,
} from './skills/load_skills_dir.js'
import type { Command } from './types/command.js'
import { getCwd } from './utilities/cwd.js'
import { isBareMode, isEnvTruthy } from './utilities/env_utils.js'
import {
  clearPluginCommandCache,
  getPluginCommands,
} from './utilities/plugins/load_plugin_commands.js'

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
  mcpSlashCommand,
  skillsSlashCommand,
  pluginSlashCommand,
  reloadPluginsSlashCommand,
]

let dynamicCommands: Command[] = []
let lastLoadedExtensionCommands: Command[] = []
let bundledInitialized = false
let commandsCacheEntry: { cwd: string; promise: Promise<Command[]> } | null =
  null

function ensureBundledInitialized(): void {
  if (bundledInitialized) return
  if (isBareMode() || isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)) {
    return
  }
  bundledInitialized = true
  initBundledSkills()
}

function deduplicateCommands(lists: ReadonlyArray<readonly Command[]>): Command[] {
  const seen = new Set<string>()
  const merged: Command[] = []
  for (const list of lists) {
    for (const cmd of list) {
      const key = cmd.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(cmd)
    }
  }
  return merged
}

export function registerDynamicCommands(commands: readonly Command[]): void {
  dynamicCommands = [...commands]
  commandsCacheEntry = null
}

export function clearDynamicCommands(): void {
  dynamicCommands = []
  commandsCacheEntry = null
}

export function clearCommandsCache(): void {
  commandsCacheEntry = null
  lastLoadedExtensionCommands = []
  clearSkillCaches()
  clearPluginCommandCache()
}

/**
 * Asynchronously loads and deduplicates built-in slash commands, bundled skills,
 * disk skills (`~/.copilot/skills`, `.copilot/skills`, `.copilot/commands`),
 * enabled plugin commands/skills, and dynamically registered commands.
 */
export async function getCommands(cwd: string = getCwd()): Promise<Command[]> {
  if (commandsCacheEntry && commandsCacheEntry.cwd === cwd) {
    return commandsCacheEntry.promise
  }

  const loadPromise = (async (): Promise<Command[]> => {
    if (isBareMode() || isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)) {
      return deduplicateCommands([BUILTIN_COMMANDS, dynamicCommands])
    }

    ensureBundledInitialized()
    const bundled = getBundledSkillCommands()
    const [skillCommands, pluginCommands] = await Promise.all([
      getSkillDirCommands(cwd).catch(() => [] as Command[]),
      getPluginCommands().catch(() => [] as Command[]),
    ])
    lastLoadedExtensionCommands = deduplicateCommands([
      skillCommands,
      pluginCommands,
    ])
    return deduplicateCommands([
      BUILTIN_COMMANDS,
      bundled,
      skillCommands,
      pluginCommands,
      dynamicCommands,
    ])
  })()

  commandsCacheEntry = { cwd, promise: loadPromise }
  return loadPromise
}

/**
 * Synchronous command snapshot returning built-ins, bundled skills, the most
 * recently loaded disk/plugin skills, dynamic commands, and optional `extraCommands`.
 */
export function getAllCommands(extraCommands?: readonly Command[]): Command[] {
  ensureBundledInitialized()
  const bundled =
    isBareMode() || isEnvTruthy(process.env.COPILOT_CLI_SIMPLE)
      ? []
      : getBundledSkillCommands()
  return deduplicateCommands([
    BUILTIN_COMMANDS,
    bundled,
    lastLoadedExtensionCommands,
    dynamicCommands,
    extraCommands ?? [],
  ])
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
