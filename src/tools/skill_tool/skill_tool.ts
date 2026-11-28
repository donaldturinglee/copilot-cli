/**
 * `SkillTool` (`Skill`): invokes discovered, bundled, plugin, or MCP prompt
 * skills in either `inline` mode (updating tool permissions/model/effort and
 * recording `invokedSkills` for post-compact restoration) or `fork` mode
 * (`runForkedAgent` isolated subagent reusing the parent prompt cache prefix).
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { join } from 'path'
import { z } from 'zod/v4'
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getProjectRoot,
  getSessionId,
} from '../../bootstrap/state.js'
import { DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../constants/tool_limits.js'
import type { HooksSettings } from '../../schemas/hooks.js'
import { buildTool, type ToolUseContext } from '../../tool.js'
import {
  getToolUseIdFromParentMessage,
  tagMessagesWithToolUseId,
} from '../../tools/utils.js'
import { getCommandName, type Command } from '../../types/command.js'
import type { CanUseToolFn } from '../../types/forward.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  getEmptyToolPermissionContext,
  type PermissionResult,
} from '../../types/permissions.js'
import type { SkillToolProgress } from '../../types/tools.js'
import {
  createCacheSafeParams,
  extractResultText,
  getLastCacheSafeParams,
  runForkedAgent,
} from '../../utilities/forked_agent.js'
import { registerSkillHooks } from '../../utilities/hooks/register_skill_hooks.js'
import { createUserMessage } from '../../utilities/messages.js'
import { resolveSkillModelOverride } from '../../utilities/model/model.js'
import { parseToolListFromCli } from '../../utilities/permissions/permission_setup.js'
import { getRulesForTool } from '../../utilities/permissions/rule_matching.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utilities/settings/plugin_only_policy.js'
import { SKILL_TOOL_NAME } from './constants.js'
import {
  formatCommandsWithinBudget,
  SKILL_TOOL_BASE_PROMPT,
  SKILL_TOOL_DESCRIPTION,
} from './prompt.js'

const SkillToolInputSchema = z.object({
  skill: z
    .string()
    .describe('The skill name (e.g. "verify", "simplify", or "plugin:skill")'),
  args: z
    .string()
    .optional()
    .describe('Optional arguments passed to the skill'),
})

export type SkillToolInput = z.infer<typeof SkillToolInputSchema>

export interface SkillToolOutput {
  success: boolean
  commandName: string
  mode: 'inline' | 'fork'
  allowedTools?: string[]
  model?: string
  result?: string
}

function normalizeSkillLookupName(raw: string): string {
  return raw.trim().replace(/^\/+/, '')
}

async function loadPromptCommandsOnly(cwd: string): Promise<Command[]> {
  const [
    { initBundledSkills, getBundledSkillCommands },
    { getSkillDirCommands },
    { getPluginCommands },
  ] = await Promise.all([
    import('../../skills/bundled/index.js'),
    import('../../skills/load_skills_dir.js'),
    import('../../utilities/plugins/load_plugin_commands.js'),
  ])
  initBundledSkills()
  const [skills, plugins] = await Promise.all([
    getSkillDirCommands(cwd).catch(() => [] as Command[]),
    getPluginCommands().catch(() => [] as Command[]),
  ])
  return [...getBundledSkillCommands(), ...skills, ...plugins]
}

async function resolveSkillCommand(
  skillName: string,
  context: ToolUseContext,
): Promise<Command | undefined> {
  const normalized = normalizeSkillLookupName(skillName).toLowerCase()
  if (!normalized) {
    return undefined
  }

  const contextCommands = (context.options?.commands ?? []) as readonly Command[]
  const diskCommands: readonly Command[] =
    contextCommands.length > 0
      ? contextCommands
      : await loadPromptCommandsOnly(getProjectRoot())
  const mcpCommands = (context.getAppState?.().mcp.commands ?? []).filter(
    c => c.type === 'prompt' && c.loadedFrom === 'mcp',
  )
  const pluginCommands = context.getAppState?.().plugins.commands ?? []

  const all = [...diskCommands, ...pluginCommands, ...mcpCommands]
  return all.find(cmd => {
    if (!(cmd.isEnabled?.() ?? true)) return false
    if (getCommandName(cmd).toLowerCase() === normalized) return true
    if (cmd.name.toLowerCase() === normalized) return true
    return cmd.aliases?.some(a => a.toLowerCase() === normalized) ?? false
  })
}

/**
 * Returns true if `cmd` declares no privileged capabilities (`allowedTools` or
 * `hooks`) so it can execute without an interactive permission dialog.
 */
export function skillHasOnlySafeProperties(cmd: Command): boolean {
  if (cmd.type !== 'prompt') {
    return false
  }
  if (cmd.allowedTools && cmd.allowedTools.length > 0) {
    return false
  }
  if (cmd.hooks && Object.keys(cmd.hooks).length > 0) {
    return false
  }
  return true
}

function ruleContentMatchesSkill(
  ruleContent: string | undefined,
  targetName: string,
  fullInvocation: string,
): boolean {
  if (ruleContent === undefined) {
    return true
  }
  const cleanRule = ruleContent.trim().replace(/^\/+/, '').toLowerCase()
  const lowerName = targetName.toLowerCase()
  const lowerFull = fullInvocation.toLowerCase()

  if (cleanRule.endsWith(':*')) {
    const prefix = cleanRule.slice(0, -2)
    return (
      lowerName === prefix ||
      lowerName.startsWith(`${prefix}:`) ||
      lowerFull === prefix ||
      lowerFull.startsWith(`${prefix} `)
    )
  }
  return lowerName === cleanRule || lowerFull === cleanRule
}

export const SkillTool = buildTool<
  SkillToolInput,
  SkillToolOutput,
  SkillToolProgress
>({
  name: SKILL_TOOL_NAME,
  searchHint: 'invoke a specialized skill or workflow',
  alwaysLoad: true,
  maxResultSizeChars: DEFAULT_MAX_RESULT_SIZE_CHARS,
  inputSchema: SkillToolInputSchema,

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,

  userFacingName(input) {
    return input?.skill ? `Skill(${input.skill})` : SKILL_TOOL_NAME
  },

  toAutoClassifierInput(input) {
    return input.args ? `${input.skill} ${input.args}` : input.skill
  },

  async description() {
    return SKILL_TOOL_DESCRIPTION
  },

  async prompt() {
    const commands = await loadPromptCommandsOnly(getProjectRoot()).catch(
      () => [] as Command[],
    )
    const listing = formatCommandsWithinBudget(commands)
    return listing
      ? `${SKILL_TOOL_BASE_PROMPT}\n\nAvailable skills:\n${listing}`
      : SKILL_TOOL_BASE_PROMPT
  },

  async validateInput(input, context) {
    const cleanName = normalizeSkillLookupName(input.skill)
    if (!cleanName) {
      return {
        result: false,
        message: 'Skill name cannot be empty.',
        errorCode: 1,
      }
    }

    const cmd = await resolveSkillCommand(cleanName, context)
    if (!cmd) {
      return {
        result: false,
        message: `Unknown skill: "${cleanName}".`,
        errorCode: 2,
      }
    }

    if (cmd.disableModelInvocation) {
      return {
        result: false,
        message: `Skill "${getCommandName(cmd)}" cannot be invoked automatically by the model.`,
        errorCode: 4,
      }
    }

    if (cmd.type !== 'prompt') {
      return {
        result: false,
        message: `"${getCommandName(cmd)}" is an interactive UI command, not a prompt skill.`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  async checkPermissions(
    input,
    context,
  ): Promise<PermissionResult<SkillToolInput>> {
    const cleanName = normalizeSkillLookupName(input.skill)
    const fullSpec = input.args?.trim()
      ? `${cleanName} ${input.args.trim()}`
      : cleanName
    const permCtx =
      context.getAppState?.().toolPermissionContext ??
      getEmptyToolPermissionContext()

    const denyRules = getRulesForTool(permCtx, { name: SKILL_TOOL_NAME }, 'deny')
    const matchedDeny = denyRules.find(r =>
      ruleContentMatchesSkill(r.ruleValue.ruleContent, cleanName, fullSpec),
    )
    if (matchedDeny) {
      return {
        behavior: 'deny',
        message: `Skill "${cleanName}" is denied by permission rule.`,
        decisionReason: { type: 'rule', rule: matchedDeny },
      }
    }

    const allowRules = getRulesForTool(
      permCtx,
      { name: SKILL_TOOL_NAME },
      'allow',
    )
    const matchedAllow = allowRules.find(r =>
      ruleContentMatchesSkill(r.ruleValue.ruleContent, cleanName, fullSpec),
    )
    if (matchedAllow) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule: matchedAllow },
      }
    }

    const cmd = await resolveSkillCommand(cleanName, context)
    if (cmd && skillHasOnlySafeProperties(cmd)) {
      return {
        behavior: 'allow',
        updatedInput: input,
      }
    }

    return {
      behavior: 'ask',
      message: `Use skill "${cleanName}"?`,
      updatedInput: input,
      metadata: cmd
        ? {
            command: {
              name: getCommandName(cmd),
              description: cmd.description,
            },
          }
        : undefined,
      suggestions: [
        {
          type: 'addRules',
          destination: 'localSettings',
          behavior: 'allow',
          rules: [{ toolName: SKILL_TOOL_NAME, ruleContent: cleanName }],
        },
        ...(input.args?.trim()
          ? [
              {
                type: 'addRules' as const,
                destination: 'localSettings' as const,
                behavior: 'allow' as const,
                rules: [
                  {
                    toolName: SKILL_TOOL_NAME,
                    ruleContent: `${cleanName}:*`,
                  },
                ],
              },
            ]
          : []),
      ],
    }
  },

  async call(input, context: ToolUseContext, canUseTool, parentMessage, onProgress) {
    const cleanName = normalizeSkillLookupName(input.skill)
    const cmd = await resolveSkillCommand(cleanName, context)
    if (!cmd || cmd.type !== 'prompt') {
      throw new Error(`Skill "${cleanName}" is not available`)
    }

    const resolvedName = getCommandName(cmd)
    const blocks = await cmd.getPromptForCommand(input.args ?? '', context)
    const textContent = blocks
      .map(b => (b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n')
    const skillPath = cmd.skillRoot
      ? join(cmd.skillRoot, 'SKILL.md')
      : resolvedName

    const toolUseId =
      getToolUseIdFromParentMessage(
        parentMessage as AssistantMessage | undefined,
        SKILL_TOOL_NAME,
      ) ?? `skill_${Date.now()}`

    // Forked isolated subagent execution (`context: 'fork'`)
    if (cmd.context === 'fork') {
      const forkAgentId = `skill_${resolvedName}_${Date.now()}` as AgentId
      const baseCacheSafe =
        getLastCacheSafeParams() ??
        createCacheSafeParams({
          systemPrompt: '' as unknown as ReturnType<
            typeof createCacheSafeParams
          >['systemPrompt'],
          userContext: {},
          systemContext: {},
          toolUseContext: context,
          messages: context.messages,
        })

      const allowedRules = cmd.allowedTools
        ? parseToolListFromCli(cmd.allowedTools)
        : []
      const baseGetAppState = context.getAppState
      const getForkAppState = baseGetAppState
        ? () => {
            const st = baseGetAppState()
            return {
              ...st,
              ...(cmd.effort !== undefined ? { effortValue: cmd.effort } : {}),
              toolPermissionContext: {
                ...st.toolPermissionContext,
                alwaysAllowRules: {
                  ...st.toolPermissionContext.alwaysAllowRules,
                  command: [
                    ...(st.toolPermissionContext.alwaysAllowRules.command ?? []),
                    ...allowedRules,
                  ],
                },
              },
            }
          }
        : undefined

      try {
        const forkResult = await runForkedAgent({
          promptMessages: [createUserMessage({ content: blocks })],
          cacheSafeParams: baseCacheSafe,
          canUseTool: (canUseTool as CanUseToolFn | undefined) ??
            (async (_t, inp) => ({ behavior: 'allow', updatedInput: inp })),
          querySource: 'agent:custom',
          forkLabel: `skill:${resolvedName}`,
          overrides: {
            agentId: forkAgentId,
            ...(getForkAppState ? { getAppState: getForkAppState } : {}),
          },
          onMessage: msg => {
            if (msg.type === 'assistant') {
              onProgress?.({
                toolUseId,
                data: {
                  type: 'skill_progress',
                  message: msg,
                  prompt: textContent,
                  agentId: forkAgentId,
                },
              })
            }
          },
        })
        const summary = extractResultText(
          forkResult.messages,
          'Skill execution completed',
        )
        return {
          data: {
            success: true,
            commandName: resolvedName,
            mode: 'fork',
            allowedTools: cmd.allowedTools,
            model: cmd.model,
            result: summary,
          },
        }
      } finally {
        clearInvokedSkillsForAgent(forkAgentId)
      }
    }

    // Inline execution (`context: 'inline'` / default)
    addInvokedSkill(
      resolvedName,
      skillPath,
      textContent,
      context.agentId ?? null,
    )

    if (
      cmd.hooks &&
      context.setAppState &&
      (!isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(cmd.source))
    ) {
      registerSkillHooks(
        context.setAppState,
        getSessionId(),
        cmd.skillRoot ?? '',
        cmd.hooks as HooksSettings,
      )
    }

    const injectedUserMsg = createUserMessage({
      content: blocks,
      isMeta: true,
    })
    const newMessages = tagMessagesWithToolUseId([injectedUserMsg], toolUseId)

    const allowedRules = cmd.allowedTools
      ? parseToolListFromCli(cmd.allowedTools)
      : []

    return {
      data: {
        success: true,
        commandName: resolvedName,
        mode: 'inline',
        ...(cmd.allowedTools ? { allowedTools: cmd.allowedTools } : {}),
        ...(cmd.model ? { model: cmd.model } : {}),
      },
      newMessages,
      contextModifier: ctx => {
        if (ctx.setAppState && (allowedRules.length > 0 || cmd.effort !== undefined)) {
          ctx.setAppState(prev => ({
            ...prev,
            ...(cmd.effort !== undefined ? { effortValue: cmd.effort } : {}),
            toolPermissionContext:
              allowedRules.length > 0
                ? {
                    ...prev.toolPermissionContext,
                    alwaysAllowRules: {
                      ...prev.toolPermissionContext.alwaysAllowRules,
                      command: [
                        ...(prev.toolPermissionContext.alwaysAllowRules.command ??
                          []),
                        ...allowedRules,
                      ],
                    },
                  }
                : prev.toolPermissionContext,
          }))
        }

        const resolvedModel = cmd.model
          ? resolveSkillModelOverride(cmd.model, ctx.options?.mainLoopModel ?? '')
          : undefined
        if (resolvedModel) {
          return {
            ...ctx,
            options: {
              ...(ctx.options ?? {}),
              mainLoopModel: resolvedModel,
            },
          }
        }
        return ctx
      },
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseId): ToolResultBlockParam {
    if (output.mode === 'fork') {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Skill "${output.commandName}" completed (forked execution).\n\nResult:\n${output.result ?? ''}`,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Launching skill: ${output.commandName}`,
    }
  },
})
