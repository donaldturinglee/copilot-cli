import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import { join } from 'path'
import type React from 'react'
import { addInvokedSkill, getSessionId } from '../../bootstrap/state.js'
import {
  type Command,
  getCommandName,
  isCommandEnabled,
  type LocalJsxCommandContext,
  type LocalJsxCommandOnDone,
} from '../../types/command.js'
import type { Message, SystemLocalCommandMessage } from '../../types/message.js'
import { randomUUID } from '../crypto.js'
import { registerSkillHooks } from '../hooks/register_skill_hooks.js'
import { parseSlashCommand } from '../slash_command_parsing.js'
import { recordSkillUsage } from '../suggestions/skill_usage_tracking.js'

export type SlashCommandExecutionResult =
  | {
      kind: 'local_text'
      commandName: string
      text: string
      messages: Message[]
    }
  | {
      kind: 'local_jsx'
      commandName: string
      element: React.ReactNode
    }
  | {
      kind: 'prompt'
      commandName: string
      blocks: ContentBlockParam[]
      allowedTools?: string[]
      model?: string
    }
  | {
      kind: 'skip'
      commandName: string
    }
  | {
      kind: 'not_found'
      commandName: string
      error: string
    }

export function findMatchingCommand(
  name: string,
  commands: readonly Command[],
): Command | undefined {
  const lower = name.toLowerCase()
  return commands.find(cmd => {
    if (!isCommandEnabled(cmd)) return false
    if (getCommandName(cmd).toLowerCase() === lower) return true
    if (cmd.name.toLowerCase() === lower) return true
    return cmd.aliases?.some(a => a.toLowerCase() === lower) ?? false
  })
}

export async function processSlashCommand(params: {
  input: string
  commands: readonly Command[]
  context: LocalJsxCommandContext
  onLocalJsxDone?: LocalJsxCommandOnDone
}): Promise<SlashCommandExecutionResult> {
  const parsed = parseSlashCommand(params.input)
  if (!parsed) {
    return {
      kind: 'not_found',
      commandName: params.input,
      error: `Invalid slash command: ${params.input}`,
    }
  }

  const cmd = findMatchingCommand(parsed.commandName, params.commands)
  if (!cmd) {
    return {
      kind: 'not_found',
      commandName: parsed.commandName,
      error: `Unknown command: /${parsed.commandName}. Type /help for available commands.`,
    }
  }

  const resolvedName = getCommandName(cmd)
  if (cmd.userInvocable === false) {
    const text = `Skill "/${resolvedName}" cannot be invoked directly by users (user-invocable: false).`
    const sysMsg: SystemLocalCommandMessage = {
      type: 'system',
      subtype: 'local_command',
      content: text,
      level: 'info',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
    }
    return {
      kind: 'local_text',
      commandName: resolvedName,
      text,
      messages: [sysMsg],
    }
  }
  recordSkillUsage(resolvedName)

  if (cmd.type === 'local') {
    const mod = await cmd.load()
    const result = await mod.call(parsed.args, params.context)
    if (result.type === 'skip') {
      return { kind: 'skip', commandName: resolvedName }
    }
    const text =
      result.type === 'text'
        ? result.value
        : result.displayText ?? 'Conversation compacted.'
    const sysMsg: SystemLocalCommandMessage = {
      type: 'system',
      subtype: 'local_command',
      content: text,
      level: 'info',
      uuid: randomUUID() as UUID,
      timestamp: new Date().toISOString(),
    }
    return {
      kind: 'local_text',
      commandName: resolvedName,
      text,
      messages: [sysMsg],
    }
  }

  if (cmd.type === 'local-jsx') {
    const mod = await cmd.load()
    const onDone: LocalJsxCommandOnDone = params.onLocalJsxDone ?? (() => {})
    const element = await mod.call(onDone, params.context, parsed.args)
    return {
      kind: 'local_jsx',
      commandName: resolvedName,
      element,
    }
  }

  // Prompt command
  const blocks = await cmd.getPromptForCommand(parsed.args, params.context)
  const promptText = blocks
    .filter((b): b is Extract<ContentBlockParam, { type: 'text' }> => b.type === 'text')
    .map(b => b.text)
    .join('\n\n')
  if (promptText) {
    const skillPath = cmd.skillRoot
      ? join(cmd.skillRoot, 'SKILL.md')
      : `skill:${resolvedName}`
    addInvokedSkill(resolvedName, skillPath, promptText, null)
  }
  if (cmd.hooks && typeof params.context.setAppState === 'function') {
    registerSkillHooks(
      params.context.setAppState as Parameters<typeof registerSkillHooks>[0],
      getSessionId(),
      cmd.skillRoot ?? '',
      cmd.hooks,
    )
  }
  return {
    kind: 'prompt',
    commandName: resolvedName,
    blocks,
    allowedTools: cmd.allowedTools,
    model: cmd.model,
  }
}
