/**
 * Executes inline `` !`cmd` `` and fenced ```` ```! ```` shell blocks inside
 * trusted skill/command prompts (strictly skipped for untrusted MCP prompts).
 */

import { BashTool } from '../tools/bash_tool/bash_tool.js'
import { PowerShellTool } from '../tools/power_shell_tool/power_shell_tool.js'
import type { AnyTool, ToolUseContext } from '../tool.js'
import { getEmptyToolPermissionContext } from '../types/permissions.js'
import { hasPermissionsToUseTool } from './permissions/permissions.js'
import { parseToolListFromCli } from './permissions/permission_setup.js'
import { processToolResultBlock } from './tool_result_storage.js'

const FENCED_SHELL_BLOCK_RE = /```!\s*\n([\s\S]*?)\n```/g
const INLINE_SHELL_RE = /(?<!\\)!`([^`\n]+)`/g

export interface ExecutePromptShellOptions {
  shell?: 'bash' | 'powershell'
  allowedTools?: readonly string[]
}

function buildContextWithSkillAllowRules(
  context: ToolUseContext,
  allowedTools?: readonly string[],
): ToolUseContext {
  if (!allowedTools || allowedTools.length === 0 || !context.getAppState) {
    return context
  }
  const parsedRules = parseToolListFromCli([...allowedTools])
  const baseGetAppState = context.getAppState
  return {
    ...context,
    getAppState: () => {
      const state = baseGetAppState()
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          alwaysAllowRules: {
            ...state.toolPermissionContext.alwaysAllowRules,
            command: [
              ...(state.toolPermissionContext.alwaysAllowRules.command ?? []),
              ...parsedRules,
            ],
          },
        },
      }
    },
  }
}

async function runSinglePromptShellCommand(
  command: string,
  shellTool: AnyTool,
  context: ToolUseContext,
): Promise<string> {
  const toolUseId = `skill_shell_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const decision = await hasPermissionsToUseTool(
    shellTool,
    { command },
    context,
    undefined,
    toolUseId,
  )
  if (decision.behavior !== 'allow') {
    throw new Error(
      `Skill inline shell command "${command}" is not permitted (${decision.message})`,
    )
  }

  const effectiveInput = decision.updatedInput ?? { command }
  const res = await shellTool.call(
    effectiveInput,
    context,
    async () => ({ behavior: 'allow', updatedInput: effectiveInput }),
    undefined,
  )
  const rawBlock = shellTool.mapToolResultToToolResultBlockParam(
    res.data,
    toolUseId,
  )
  const processed = processToolResultBlock(
    rawBlock,
    shellTool.maxResultSizeChars,
  )
  if (typeof processed.content === 'string') {
    return processed.content.trimEnd()
  }
  if (Array.isArray(processed.content)) {
    return processed.content
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trimEnd()
  }
  return ''
}

/**
 * Expands ```` ```! ... ``` ```` and `` !`...` `` shell expressions in `text`.
 */
export async function executeShellCommandsInPrompt(
  text: string,
  context: ToolUseContext,
  options?: ExecutePromptShellOptions,
): Promise<string> {
  if (!text.includes('!`') && !text.includes('```!')) {
    return text
  }

  const shellTool: AnyTool =
    options?.shell === 'powershell'
      ? (PowerShellTool as unknown as AnyTool)
      : (BashTool as unknown as AnyTool)
  const effectiveCtx = buildContextWithSkillAllowRules(
    context,
    options?.allowedTools,
  )

  let result = text

  const fencedMatches = Array.from(result.matchAll(FENCED_SHELL_BLOCK_RE))
  for (const match of fencedMatches) {
    const full = match[0]
    const cmd = (match[1] ?? '').trim()
    if (!full || !cmd) continue
    const stdout = await runSinglePromptShellCommand(
      cmd,
      shellTool,
      effectiveCtx,
    )
    // Use function replacer so `$` sequences in command stdout are preserved literally
    result = result.replace(full, () => stdout)
  }

  const inlineMatches = Array.from(result.matchAll(INLINE_SHELL_RE))
  for (const match of inlineMatches) {
    const full = match[0]
    const cmd = (match[1] ?? '').trim()
    if (!full || !cmd) continue
    const stdout = await runSinglePromptShellCommand(
      cmd,
      shellTool,
      effectiveCtx,
    )
    result = result.replace(full, () => stdout)
  }

  return result
}

export { getEmptyToolPermissionContext }
