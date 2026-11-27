import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
  type LocalCommandCall,
  type LocalJsxCommandCall,
} from '../types/command.js'
import { substituteCommandArguments } from '../utilities/argument_substitution.js'

/**
 * Commands permitted in remote/cloud-hosted sessions.
 */
export const REMOTE_SAFE_COMMANDS = new Set<string>([
  'help',
  'clear',
  'compact',
  'context',
  'cost',
  'stats',
  'status',
  'model',
  'effort',
  'fast',
  'theme',
  'output-style',
  'vim',
  'btw',
  'version',
  'release-notes',
  'export',
  'copy',
  'brief',
  'review',
  'plan',
  'rename',
  'tag',
  'branch',
  'rewind',
])

/**
 * Commands permitted over remote bridge / IDE channels.
 */
export const BRIDGE_SAFE_COMMANDS = new Set<string>([
  'help',
  'clear',
  'compact',
  'context',
  'cost',
  'stats',
  'status',
  'model',
  'effort',
  'fast',
  'btw',
  'version',
  'plan',
  'rename',
  'tag',
  'review',
])

export function isRemoteSafeCommand(name: string): boolean {
  return REMOTE_SAFE_COMMANDS.has(name.toLowerCase())
}

export function isBridgeSafeCommand(name: string): boolean {
  return BRIDGE_SAFE_COMMANDS.has(name.toLowerCase())
}

export function makeLocalCommand(config: {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  immediate?: boolean
  supportsNonInteractive?: boolean
  isHidden?: boolean
  call: LocalCommandCall
}): Command {
  return {
    type: 'local',
    name: config.name,
    description: config.description,
    aliases: config.aliases,
    argumentHint: config.argumentHint,
    immediate: config.immediate,
    isHidden: config.isHidden,
    supportsNonInteractive: config.supportsNonInteractive ?? true,
    load: async () => ({ call: config.call }),
  }
}

export function makeLocalJsxCommand(config: {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  immediate?: boolean
  isHidden?: boolean
  call: LocalJsxCommandCall
}): Command {
  return {
    type: 'local-jsx',
    name: config.name,
    description: config.description,
    aliases: config.aliases,
    argumentHint: config.argumentHint,
    immediate: config.immediate,
    isHidden: config.isHidden,
    load: async () => ({ call: config.call }),
  }
}

export function makePromptCommand(config: {
  name: string
  description: string
  template: string
  progressMessage?: string
  aliases?: string[]
  argumentHint?: string
  argNames?: string[]
  allowedTools?: string[]
  model?: string
}): Command {
  return {
    type: 'prompt',
    name: config.name,
    description: config.description,
    aliases: config.aliases,
    argumentHint: config.argumentHint,
    argNames: config.argNames,
    allowedTools: config.allowedTools,
    model: config.model,
    source: 'builtin',
    progressMessage: config.progressMessage ?? `Running /${config.name}…`,
    contentLength: config.template.length,
    getPromptForCommand: async (args): Promise<ContentBlockParam[]> => [
      {
        type: 'text',
        text: substituteCommandArguments(config.template, args, config.argNames),
      },
    ],
  }
}

export function findCommandByName(
  name: string,
  commands: readonly Command[],
): Command | undefined {
  const lower = name.toLowerCase().replace(/^\//, '')
  return commands.find(cmd => {
    if (!isCommandEnabled(cmd)) return false
    if (getCommandName(cmd).toLowerCase() === lower) return true
    if (cmd.name.toLowerCase() === lower) return true
    return cmd.aliases?.some(a => a.toLowerCase() === lower) ?? false
  })
}

export function filterVisibleCommands(commands: readonly Command[]): Command[] {
  return commands.filter(c => !c.isHidden && isCommandEnabled(c))
}
