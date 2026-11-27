import { z } from 'zod/v4'
import { EXTERNAL_PERMISSION_MODES } from '../../types/permissions.js'
import { isEnvTruthy } from '../env_utils.js'
import { isFeatureEnabled } from '../feature_flags.js'
import { lazySchema } from '../lazy_schema.js'
import { PermissionRuleSchema } from './permission_validation.js'

export const CUSTOMIZATION_SURFACES = [
  'skills',
  'agents',
  'hooks',
  'mcp',
] as const

export type CustomizationSurface = (typeof CUSTOMIZATION_SURFACES)[number]

const VALID_CUSTOMIZATION_SURFACE_SET = new Set<string>(CUSTOMIZATION_SURFACES)

export const BashCommandHookSchema = lazySchema(() =>
  z.object({
    type: z.literal('command'),
    command: z.string(),
    if: z.string().optional(),
    shell: z.enum(['bash', 'powershell']).optional(),
    timeout: z.number().positive().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
  }),
)

export const PromptHookSchema = lazySchema(() =>
  z.object({
    type: z.literal('prompt'),
    prompt: z.string(),
    if: z.string().optional(),
    model: z.string().optional(),
    timeout: z.number().positive().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
  }),
)

export const AgentHookSchema = lazySchema(() =>
  z.object({
    type: z.literal('agent'),
    prompt: z.string(),
    if: z.string().optional(),
    model: z.string().optional(),
    timeout: z.number().positive().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
  }),
)

export const HttpHookSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string(),
    if: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    timeout: z.number().positive().optional(),
    statusMessage: z.string().optional(),
    once: z.boolean().optional(),
  }),
)

export const HookCommandSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    BashCommandHookSchema(),
    PromptHookSchema(),
    AgentHookSchema(),
    HttpHookSchema(),
  ]),
)

export const HookMatcherSchema = lazySchema(() =>
  z.object({
    matcher: z.string().optional(),
    hooks: z.array(HookCommandSchema()),
  }),
)

export const HooksSchema = lazySchema(() =>
  z.record(z.string(), z.array(HookMatcherSchema())),
)

export type BashCommandHook = z.infer<ReturnType<typeof BashCommandHookSchema>>
export type PromptHook = z.infer<ReturnType<typeof PromptHookSchema>>
export type AgentHook = z.infer<ReturnType<typeof AgentHookSchema>>
export type HttpHook = z.infer<ReturnType<typeof HttpHookSchema>>
export type HookCommand = z.infer<ReturnType<typeof HookCommandSchema>>
export type HookMatcher = z.infer<ReturnType<typeof HookMatcherSchema>>
export type HooksSettings = z.infer<ReturnType<typeof HooksSchema>>

export type PluginHookMatcher = HookMatcher & {
  pluginRoot: string
  pluginName?: string
  pluginId?: string
}

export type SkillHookMatcher = HookMatcher & {
  skillRoot: string
  skillName: string
}

export const EnvironmentVariablesSchema = lazySchema(() =>
  z.record(z.string(), z.coerce.string()),
)

export const PermissionsSchema = lazySchema(() =>
  z
    .object({
      allow: z.array(PermissionRuleSchema()).optional(),
      deny: z.array(PermissionRuleSchema()).optional(),
      ask: z.array(PermissionRuleSchema()).optional(),
      defaultMode: z.enum(EXTERNAL_PERMISSION_MODES).optional(),
      disableBypassPermissionsMode: z.literal('disable').optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .passthrough(),
)

export const SandboxSettingsSchema = lazySchema(() =>
  z
    .object({
      enabled: z.boolean().optional(),
      autoAllowBashIfSandboxed: z.boolean().optional(),
      allowUnsandboxedCommands: z.boolean().optional(),
      excludedCommands: z.array(z.string()).optional(),
      network: z
        .object({
          allowedDomains: z.array(z.string()).optional(),
          allowUnixSockets: z.array(z.string()).optional(),
          allowAllUnixSockets: z.boolean().optional(),
          allowLocalBinding: z.boolean().optional(),
          httpProxyPort: z.number().optional(),
          socksProxyPort: z.number().optional(),
        })
        .passthrough()
        .optional(),
      filesystem: z
        .object({
          allowWrite: z.array(z.string()).optional(),
          denyWrite: z.array(z.string()).optional(),
          denyRead: z.array(z.string()).optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
)

export const MarketplaceSourceSchema = lazySchema(() =>
  z
    .object({
      source: z.string(),
      repo: z.string().optional(),
      url: z.string().optional(),
      path: z.string().optional(),
      name: z.string().optional(),
      ref: z.string().optional(),
    })
    .passthrough(),
)

export const ExtraKnownMarketplaceSchema = lazySchema(() =>
  z
    .object({
      source: MarketplaceSourceSchema(),
      autoUpdate: z.boolean().optional(),
    })
    .passthrough(),
)

const McpServerEntryBaseSchema = lazySchema(() =>
  z
    .object({
      serverName: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .optional(),
      serverCommand: z.array(z.string()).min(1).optional(),
      serverUrl: z.string().min(1).optional(),
    })
    .refine(
      entry => {
        const count =
          Number(entry.serverName !== undefined) +
          Number(entry.serverCommand !== undefined) +
          Number(entry.serverUrl !== undefined)
        return count === 1
      },
      {
        message:
          'Exactly one of serverName, serverCommand, or serverUrl must be specified',
      },
    ),
)

export const AllowedMcpServerEntrySchema = McpServerEntryBaseSchema
export const DeniedMcpServerEntrySchema = McpServerEntryBaseSchema

export type AllowedMcpServerEntry = z.infer<
  ReturnType<typeof AllowedMcpServerEntrySchema>
>
export type DeniedMcpServerEntry = z.infer<
  ReturnType<typeof DeniedMcpServerEntrySchema>
>

export function isMcpServerNameEntry(
  entry: AllowedMcpServerEntry,
): entry is { serverName: string } {
  return entry.serverName !== undefined
}

export function isMcpServerCommandEntry(
  entry: AllowedMcpServerEntry,
): entry is { serverCommand: string[] } {
  return entry.serverCommand !== undefined
}

export function isMcpServerUrlEntry(
  entry: AllowedMcpServerEntry,
): entry is { serverUrl: string } {
  return entry.serverUrl !== undefined
}

export type UserConfigValues = Record<string, string | number | boolean>

export type PluginConfig = {
  mcpServers?: Record<string, Record<string, unknown>>
  userConfig?: UserConfigValues
  [key: string]: unknown
}

const StrictPluginOnlyCustomizationSchema = lazySchema(() =>
  z
    .preprocess(value => {
      if (Array.isArray(value)) {
        return value.filter(
          item =>
            typeof item === 'string' &&
            VALID_CUSTOMIZATION_SURFACE_SET.has(item),
        )
      }
      return value
    }, z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))]))
    .optional()
    .catch(undefined),
)

export const SettingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z.string().optional(),
      apiKeyHelper: z.string().optional(),
      awsCredentialExport: z.string().optional(),
      awsAuthRefresh: z.string().optional(),
      gcpAuthRefresh: z.string().optional(),
      ...(isEnvTruthy(process.env.COPILOT_CLI_ENABLE_XAA)
        ? { xaaIdp: z.record(z.string(), z.unknown()).optional() }
        : {}),
      fileSuggestion: z
        .object({
          type: z.literal('command'),
          command: z.string(),
        })
        .optional(),
      respectGitignore: z.boolean().optional(),
      cleanupPeriodDays: z.number().int().nonnegative().optional(),
      env: EnvironmentVariablesSchema().optional(),
      attribution: z
        .object({
          commit: z.string().optional(),
          pr: z.string().optional(),
        })
        .optional(),
      includeCoAuthoredBy: z.boolean().optional(),
      includeGitInstructions: z.boolean().optional(),
      permissions: PermissionsSchema().optional(),
      model: z.string().optional(),
      availableModels: z.array(z.string()).optional(),
      modelOverrides: z.record(z.string(), z.string()).optional(),
      enableAllProjectMcpServers: z.boolean().optional(),
      enabledMcpjsonServers: z.array(z.string()).optional(),
      disabledMcpjsonServers: z.array(z.string()).optional(),
      allowedMcpServers: z.array(AllowedMcpServerEntrySchema()).optional(),
      deniedMcpServers: z.array(DeniedMcpServerEntrySchema()).optional(),
      hooks: HooksSchema().optional(),
      worktree: z
        .object({
          symlinkDirectories: z.array(z.string()).optional(),
          sparsePaths: z.array(z.string()).optional(),
        })
        .optional(),
      disableAllHooks: z.boolean().optional(),
      defaultShell: z.enum(['bash', 'powershell']).optional(),
      allowManagedHooksOnly: z.boolean().optional(),
      allowedHttpHookUrls: z.array(z.string()).optional(),
      httpHookAllowedEnvVars: z.array(z.string()).optional(),
      allowManagedPermissionRulesOnly: z.boolean().optional(),
      allowManagedMcpServersOnly: z.boolean().optional(),
      strictPluginOnlyCustomization: StrictPluginOnlyCustomizationSchema(),
      statusLine: z
        .object({
          type: z.literal('command'),
          command: z.string(),
          padding: z.number().optional(),
        })
        .optional(),
      enabledPlugins: z
        .record(z.string(), z.union([z.boolean(), z.array(z.string())]))
        .optional(),
      extraKnownMarketplaces: z
        .record(z.string(), ExtraKnownMarketplaceSchema())
        .check(ctx => {
          for (const [key, entry] of Object.entries(ctx.value)) {
            if (
              entry.source.source === 'settings' &&
              entry.source.name !== key
            ) {
              ctx.issues.push({
                code: 'custom',
                input: entry,
                path: [key, 'source', 'name'],
                message: `Settings marketplace name "${entry.source.name}" must match key "${key}"`,
              })
            }
          }
        })
        .optional(),
      strictKnownMarketplaces: z.array(MarketplaceSourceSchema()).optional(),
      blockedMarketplaces: z.array(MarketplaceSourceSchema()).optional(),
      forceLoginMethod: z.enum(['claudeai', 'console']).optional(),
      forceLoginOrgUUID: z.string().optional(),
      otelHeadersHelper: z.string().optional(),
      outputStyle: z.string().optional(),
      language: z.string().optional(),
      skipWebFetchPreflight: z.boolean().optional(),
      sandbox: SandboxSettingsSchema().optional(),
      feedbackSurveyRate: z.number().min(0).max(1).optional(),
      spinnerTipsEnabled: z.boolean().optional(),
      spinnerVerbs: z
        .object({
          mode: z.enum(['append', 'replace']),
          verbs: z.array(z.string()),
        })
        .optional(),
      spinnerTipsOverride: z
        .object({
          excludeDefault: z.boolean().optional(),
          tips: z.array(z.string()),
        })
        .optional(),
      syntaxHighlightingDisabled: z.boolean().optional(),
      terminalTitleFromRename: z.boolean().optional(),
      alwaysThinkingEnabled: z.boolean().optional(),
      effortLevel: z
        .enum(['low', 'medium', 'high', 'max'])
        .optional()
        .catch(undefined),
      advisorModel: z.string().optional(),
      fastMode: z.boolean().optional(),
      fastModePerSessionOptIn: z.boolean().optional(),
      promptSuggestionEnabled: z.boolean().optional(),
      showClearContextOnPlanAccept: z.boolean().optional(),
      agent: z.string().optional(),
      companyAnnouncements: z.array(z.string()).optional(),
      pluginConfigs: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional(),
      remote: z
        .object({
          defaultEnvironmentId: z.string().optional(),
        })
        .optional(),
      autoUpdatesChannel: z.enum(['latest', 'stable']).optional(),
      ...(isFeatureEnabled('LODESTONE')
        ? { disableDeepLinkRegistration: z.boolean().optional() }
        : {}),
      minimumVersion: z.string().optional(),
      plansDirectory: z.string().optional(),
      ...(isFeatureEnabled('PROACTIVE') || isFeatureEnabled('KAIROS')
        ? {
            minSleepDurationMs: z.number().nonnegative().optional(),
            maxSleepDurationMs: z.number().nonnegative().optional(),
          }
        : {}),
      ...(isFeatureEnabled('VOICE_MODE')
        ? { voiceEnabled: z.boolean().optional() }
        : {}),
      ...(isFeatureEnabled('KAIROS')
        ? {
            assistant: z.boolean().optional(),
            assistantName: z.string().optional(),
          }
        : {}),
      channelsEnabled: z.boolean().optional(),
      allowedChannelPlugins: z
        .array(
          z.object({
            marketplace: z.string(),
            plugin: z.string(),
          }),
        )
        .optional(),
      ...(isFeatureEnabled('KAIROS') || isFeatureEnabled('KAIROS_BRIEF')
        ? { defaultView: z.string().optional() }
        : {}),
      prefersReducedMotion: z.boolean().optional(),
      autoMemoryEnabled: z.boolean().optional(),
      autoMemoryDirectory: z.string().optional(),
      autoDreamEnabled: z.boolean().optional(),
      showThinkingSummaries: z.boolean().optional(),
      skipDangerousModePermissionPrompt: z.boolean().optional(),
      ...(isFeatureEnabled('TRANSCRIPT_CLASSIFIER')
        ? {
            skipAutoPermissionPrompt: z.boolean().optional(),
            useAutoModeDuringPlan: z.boolean().optional(),
            autoMode: z
              .object({
                allow: z.array(z.string()).optional(),
                soft_deny: z.array(z.string()).optional(),
                environment: z.array(z.string()).optional(),
              })
              .optional(),
          }
        : {}),
      disableAutoMode: z.literal('disable').optional(),
      sshConfigs: z.record(z.string(), z.unknown()).optional(),
      claudeMdExcludes: z.array(z.string()).optional(),
      pluginTrustMessage: z.string().optional(),
    })
    .passthrough(),
)

export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>
