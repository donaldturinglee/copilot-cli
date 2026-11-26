/**
 * Shared event metadata enrichment for analytics systems.
 *
 * Uses pluggable providers for downstream Phase 2+ concerns (model defaults,
 * auth subscription tier, git repo hash, agent context) so Phase 1 has zero
 * backward imports.
 */

import memoize from 'lodash-es/memoize.js'
import { extname } from 'path'
import {
  getClientType,
  getIsInteractive,
  getKairosActive,
  getParentSessionId as getParentSessionIdFromState,
  getSessionId,
} from '../../bootstrap/state.js'
import type { CoreUserData } from '../../types/forward.js'
import { isEnvTruthy } from '../../utilities/env_utils.js'
import { isFeatureEnabled } from '../../utilities/feature_flags.js'
import {
  detectVcs,
  getLinuxDistroInfo,
  getWslVersion,
} from '../../utilities/platform.js'
import { jsonStringify } from '../../utilities/slow_operations.js'
import type { VerifiedNonSensitiveAnalyticsMetadata } from './index.js'

export type AnalyticsMetadataProviders = {
  getMainLoopModel?: () => string
  getModelBetas?: (model: string) => string[]
  getSubscriptionType?: () => string | undefined
  isClaudeAiSubscriber?: () => boolean
  getRepoRemoteHash?: () => Promise<string | undefined>
  isOfficialMcpUrl?: (url: string) => boolean
  getAgentIdentification?: () => {
    agentId?: string
    parentSessionId?: string
    agentType?: 'teammate' | 'subagent' | 'standalone'
    teamName?: string
  }
  getEnvironmentInfo?: () => Promise<{
    platform: string
    arch: string
    nodeVersion: string
    terminal: string | null
    packageManagers: string[]
    runtimes: string[]
    isRunningWithBun: boolean
    isConductor: boolean
    deploymentEnvironment: string
  }>
}

let providers: AnalyticsMetadataProviders = {}

export function registerAnalyticsMetadataProviders(
  nextProviders: Partial<AnalyticsMetadataProviders>,
): void {
  providers = { ...providers, ...nextProviders }
}

/**
 * Sanitizes tool names for analytics logging to avoid PII exposure.
 * Redacts `mcp__*` tool names to `'mcp_tool'`.
 */
export function sanitizeToolNameForAnalytics(
  toolName: string,
): VerifiedNonSensitiveAnalyticsMetadata {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as VerifiedNonSensitiveAnalyticsMetadata
  }
  return toolName as VerifiedNonSensitiveAnalyticsMetadata
}

export function isToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  if (process.env.COPILOT_CLI_ENTRYPOINT === 'local-agent') {
    return true
  }
  if (mcpServerType === 'claudeai-proxy') {
    return true
  }
  if (mcpServerBaseUrl && providers.isOfficialMcpUrl?.(mcpServerBaseUrl)) {
    return true
  }
  return false
}

export function extractMcpToolDetails(toolName: string):
  | {
      serverName: VerifiedNonSensitiveAnalyticsMetadata
      mcpToolName: VerifiedNonSensitiveAnalyticsMetadata
    }
  | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }
  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }
  const serverName = parts[1]
  const mcpToolName = parts.slice(2).join('__')
  if (!serverName || !mcpToolName) {
    return undefined
  }
  return {
    serverName: serverName as VerifiedNonSensitiveAnalyticsMetadata,
    mcpToolName: mcpToolName as VerifiedNonSensitiveAnalyticsMetadata,
  }
}

export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): {
  mcpServerName?: VerifiedNonSensitiveAnalyticsMetadata
  mcpToolName?: VerifiedNonSensitiveAnalyticsMetadata
} {
  const details = extractMcpToolDetails(toolName)
  if (!details) {
    return {}
  }
  if (!isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)) {
    return {}
  }
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  }
}

export function extractSkillName(
  toolName: string,
  input: unknown,
): VerifiedNonSensitiveAnalyticsMetadata | undefined {
  if (toolName !== 'Skill') {
    return undefined
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'skill' in input &&
    typeof (input as { skill: unknown }).skill === 'string'
  ) {
    return (input as { skill: string })
      .skill as VerifiedNonSensitiveAnalyticsMetadata
  }
  return undefined
}

const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_TRUNCATE_TO = 128
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20
const TOOL_INPUT_MAX_DEPTH = 2

function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} chars]`
    }
    return value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return '<nested>'
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(item => truncateToolInputValue(item, depth + 1))
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} items]`)
    }
    return mapped
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([key]) => !key.startsWith('_'),
    )
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([key, item]) => [key, truncateToolInputValue(item, depth + 1)])
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(['…', `${entries.length} keys`])
    }
    return Object.fromEntries(mapped)
  }
  return String(value)
}

export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) {
    return undefined
  }
  const truncated = truncateToolInputValue(input)
  let json = jsonStringify(truncated)
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + '…[truncated]'
  }
  return json
}

const MAX_FILE_EXTENSION_LENGTH = 10

export function getFileExtensionForAnalytics(
  filePath: string,
): VerifiedNonSensitiveAnalyticsMetadata | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }
  const extension = ext.slice(1)
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as VerifiedNonSensitiveAnalyticsMetadata
  }
  return extension as VerifiedNonSensitiveAnalyticsMetadata
}

const FILE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'cat',
  'head',
  'tail',
  'sort',
  'stat',
  'diff',
  'wc',
  'grep',
  'rg',
  'sed',
])

const COMPOUND_OPERATOR_REGEX = /\s*(?:&&|\|\||[;|])\s*/
const WHITESPACE_REGEX = /\s+/

export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): VerifiedNonSensitiveAnalyticsMetadata | undefined {
  if (!command.includes('.') && !simulatedSedEditFilePath) return undefined

  let result: string | undefined
  const seen = new Set<string>()

  if (simulatedSedEditFilePath) {
    const ext = getFileExtensionForAnalytics(simulatedSedEditFilePath)
    if (ext) {
      seen.add(ext)
      result = ext
    }
  }

  for (const subcmd of command.split(COMPOUND_OPERATOR_REGEX)) {
    if (!subcmd) continue
    const tokens = subcmd.split(WHITESPACE_REGEX)
    if (tokens.length < 2) continue

    const firstToken = tokens[0]!
    const slashIdx = firstToken.lastIndexOf('/')
    const baseCmd = slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken
    if (!FILE_COMMANDS.has(baseCmd)) continue

    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
      if (arg.charCodeAt(0) === 45) continue
      const ext = getFileExtensionForAnalytics(arg)
      if (ext && !seen.has(ext)) {
        seen.add(ext)
        result = result ? result + ',' + ext : ext
      }
    }
  }

  if (!result) return undefined
  return result as VerifiedNonSensitiveAnalyticsMetadata
}

export type EnvContext = {
  platform: string
  platformRaw: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string
}

export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}

export type EventMetadata = {
  model: string
  sessionId: string
  userType: string
  betas?: string
  envContext: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  sweBenchRunId: string
  sweBenchInstanceId: string
  sweBenchTaskId: string
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
  subscriptionType?: string
  repoHash?: string
  kairosActive?: true
}

export type EnrichMetadataOptions = {
  model?: unknown
  betas?: unknown
  additionalMetadata?: Record<string, unknown>
}

function getAgentIdentification(): {
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
} {
  const fromProvider = providers.getAgentIdentification?.()
  if (fromProvider && Object.keys(fromProvider).length > 0) {
    return fromProvider
  }
  const stateParentSessionId = getParentSessionIdFromState()
  if (stateParentSessionId) {
    return { parentSessionId: stateParentSessionId }
  }
  return {}
}

function getVersionString(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

function getBuildTimeString(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { BUILD_TIME?: string } }
  ).MACRO
  return macroGlobal?.BUILD_TIME ?? ''
}

const getVersionBase = memoize((): string | undefined => {
  const match = getVersionString().match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : undefined
})

const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  const [envInfo, linuxDistroInfo, vcs] = await Promise.all([
    providers.getEnvironmentInfo
      ? providers.getEnvironmentInfo()
      : Promise.resolve({
          platform:
            process.platform === 'darwin'
              ? 'darwin'
              : process.platform === 'win32'
                ? 'win32'
                : 'linux',
          arch: process.arch,
          nodeVersion: process.version,
          terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? null,
          packageManagers: [] as string[],
          runtimes: [] as string[],
          isRunningWithBun: typeof Bun !== 'undefined',
          isConductor: false,
          deploymentEnvironment: 'unknown-node',
        }),
    getLinuxDistroInfo(),
    detectVcs(),
  ])

  const wslVersion = getWslVersion()
  return {
    platform: envInfo.platform,
    platformRaw: process.env.COPILOT_CLI_HOST_PLATFORM || process.platform,
    arch: envInfo.arch,
    nodeVersion: envInfo.nodeVersion,
    terminal: envInfo.terminal,
    packageManagers: envInfo.packageManagers.join(','),
    runtimes: envInfo.runtimes.join(','),
    isRunningWithBun: envInfo.isRunningWithBun,
    isCi: isEnvTruthy(process.env.CI),
    isClaubbit: isEnvTruthy(process.env.CLAUBBIT),
    isClaudeCodeRemote: isEnvTruthy(process.env.COPILOT_CLI_REMOTE),
    isLocalAgentMode: process.env.COPILOT_CLI_ENTRYPOINT === 'local-agent',
    isConductor: envInfo.isConductor,
    ...(process.env.COPILOT_CLI_REMOTE_ENVIRONMENT_TYPE && {
      remoteEnvironmentType: process.env.COPILOT_CLI_REMOTE_ENVIRONMENT_TYPE,
    }),
    ...(process.env.COPILOT_CLI_CONTAINER_ID && {
      claudeCodeContainerId: process.env.COPILOT_CLI_CONTAINER_ID,
    }),
    ...(process.env.COPILOT_CLI_REMOTE_SESSION_ID && {
      claudeCodeRemoteSessionId: process.env.COPILOT_CLI_REMOTE_SESSION_ID,
    }),
    ...(process.env.COPILOT_CLI_TAGS && {
      tags: process.env.COPILOT_CLI_TAGS,
    }),
    isGithubAction: isEnvTruthy(process.env.GITHUB_ACTIONS),
    isClaudeCodeAction: isEnvTruthy(process.env.COPILOT_CLI_ACTION),
    isClaudeAiAuth: providers.isClaudeAiSubscriber?.() ?? false,
    version: getVersionString(),
    versionBase: getVersionBase(),
    buildTime: getBuildTimeString(),
    deploymentEnvironment: envInfo.deploymentEnvironment,
    ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubActionsRunnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      githubActionsRunnerOs: process.env.RUNNER_OS,
      githubActionRef: process.env.GITHUB_ACTION_PATH?.includes(
        'claude-code-action/',
      )
        ? process.env.GITHUB_ACTION_PATH.split('claude-code-action/')[1]
        : undefined,
    }),
    ...(wslVersion && { wslVersion }),
    ...(linuxDistroInfo ?? {}),
    ...(vcs.length > 0 ? { vcs: vcs.join(',') } : {}),
  }
})

let prevCpuUsage: NodeJS.CpuUsage | null = null
let prevWallTimeMs: number | null = null

function buildProcessMetrics(): ProcessMetrics | undefined {
  try {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()

    let cpuPercent: number | undefined
    if (prevCpuUsage && prevWallTimeMs) {
      const wallDeltaMs = now - prevWallTimeMs
      if (wallDeltaMs > 0) {
        const userDeltaUs = cpu.user - prevCpuUsage.user
        const systemDeltaUs = cpu.system - prevCpuUsage.system
        cpuPercent =
          ((userDeltaUs + systemDeltaUs) / (wallDeltaMs * 1000)) * 100
      }
    }
    prevCpuUsage = cpu
    prevWallTimeMs = now

    return {
      uptime: process.uptime(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      constrainedMemory:
        typeof process.constrainedMemory === 'function'
          ? process.constrainedMemory()
          : undefined,
      cpuUsage: cpu,
      cpuPercent,
    }
  } catch {
    return undefined
  }
}

export async function getEventMetadata(
  options: EnrichMetadataOptions = {},
): Promise<EventMetadata> {
  const model = options.model
    ? String(options.model)
    : (providers.getMainLoopModel?.() ?? '')
  const betas =
    typeof options.betas === 'string'
      ? options.betas
      : (providers.getModelBetas?.(model).join(',') ?? '')
  const [envContext, repoRemoteHash] = await Promise.all([
    buildEnvContext(),
    providers.getRepoRemoteHash
      ? providers.getRepoRemoteHash()
      : Promise.resolve(undefined),
  ])
  const processMetrics = buildProcessMetrics()
  const subscriptionType = providers.getSubscriptionType?.()

  return {
    model,
    sessionId: getSessionId(),
    userType: process.env.USER_TYPE || '',
    ...(betas.length > 0 ? { betas } : {}),
    envContext,
    ...(process.env.COPILOT_CLI_ENTRYPOINT && {
      entrypoint: process.env.COPILOT_CLI_ENTRYPOINT,
    }),
    ...(process.env.CLAUDE_AGENT_SDK_VERSION && {
      agentSdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION,
    }),
    isInteractive: String(getIsInteractive()),
    clientType: getClientType(),
    ...(processMetrics && { processMetrics }),
    sweBenchRunId: process.env.SWE_BENCH_RUN_ID || '',
    sweBenchInstanceId: process.env.SWE_BENCH_INSTANCE_ID || '',
    sweBenchTaskId: process.env.SWE_BENCH_TASK_ID || '',
    ...getAgentIdentification(),
    ...(subscriptionType && { subscriptionType }),
    ...(isFeatureEnabled('KAIROS') && getKairosActive()
      ? { kairosActive: true as const }
      : {}),
    ...(repoRemoteHash && { repoHash: repoRemoteHash }),
  }
}

export type FirstPartyEventLoggingMetadata = {
  env: Record<string, unknown>
  process?: string
  auth?: Record<string, unknown>
  core: Record<string, unknown>
  additional: Record<string, unknown>
}

export function toFirstPartyEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata: Record<string, unknown> = {},
): FirstPartyEventLoggingMetadata {
  return {
    env: {
      platform: metadata.envContext.platform,
      platform_raw: metadata.envContext.platformRaw,
      arch: metadata.envContext.arch,
      node_version: metadata.envContext.nodeVersion,
      terminal: metadata.envContext.terminal,
      version: metadata.envContext.version,
      deployment_environment: metadata.envContext.deploymentEnvironment,
    },
    ...(metadata.processMetrics
      ? { process: jsonStringify(metadata.processMetrics) }
      : {}),
    auth: {
      ...(userMetadata.organizationUuid
        ? { organization_uuid: userMetadata.organizationUuid }
        : {}),
      ...(userMetadata.accountUuid
        ? { account_uuid: userMetadata.accountUuid }
        : {}),
    },
    core: {
      session_id: metadata.sessionId,
      model: metadata.model,
      user_type: metadata.userType,
      ...(metadata.betas ? { betas: metadata.betas } : {}),
      ...(metadata.entrypoint ? { entrypoint: metadata.entrypoint } : {}),
      is_interactive: metadata.isInteractive === 'true',
      client_type: metadata.clientType,
      ...(metadata.agentId ? { agent_id: metadata.agentId } : {}),
      ...(metadata.parentSessionId
        ? { parent_session_id: metadata.parentSessionId }
        : {}),
      ...(metadata.agentType ? { agent_type: metadata.agentType } : {}),
      ...(metadata.teamName ? { team_name: metadata.teamName } : {}),
    },
    additional: additionalMetadata,
  }
}
