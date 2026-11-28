/**
 * Multi-scope MCP configuration loader, exclusive enterprise `managed-mcp.json`
 * enforcement, content-signature deduplication, policy filtering, and CRUD
 * mutations.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { dirname, join, resolve } from 'path'
import {
  getCurrentProjectConfig,
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../../utilities/config.js'
import { getCwd } from '../../utilities/cwd.js'
import { logForDebugging } from '../../utilities/debug.js'
import { getManagedFilePath } from '../../utilities/settings/managed_path.js'
import { isRestrictedToPluginOnly } from '../../utilities/settings/plugin_only_policy.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../../utilities/settings/settings.js'
import {
  isMcpServerCommandEntry,
  isMcpServerNameEntry,
  isMcpServerUrlEntry,
  type AllowedMcpServerEntry,
} from '../../utilities/settings/types.js'
import { fetchClaudeAiMcpConfigs } from './claudeai.js'
import { expandEnvVarsInConfig } from './env_expansion.js'
import {
  McpJsonConfigSchema,
  McpServerConfigSchema,
  type ConfigScope,
  type McpConfigWarning,
  type McpServerConfig,
  type ScopedMcpServerConfig,
} from './types.js'

export type PluginMcpServersProvider = () => Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: string[]
}>

let pluginMcpProvider: PluginMcpServersProvider | null = null

/**
 * Registers the Step 8.3 plugin MCP server loader so `services/mcp/config.ts`
 * merges plugin MCP servers without circular imports.
 */
export function registerPluginMcpServersProvider(
  provider: PluginMcpServersProvider | null,
): void {
  pluginMcpProvider = provider
}

/**
 * Returns the path to enterprise `managed-mcp.json`.
 */
export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), 'managed-mcp.json')
}

/**
 * Returns true if a valid enterprise `managed-mcp.json` exists on disk,
 * activating exclusive managed MCP mode.
 */
export const doesEnterpriseMcpConfigExist = memoize((): boolean => {
  const filePath = getEnterpriseMcpFilePath()
  if (!existsSync(filePath)) {
    return false
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return McpJsonConfigSchema().safeParse(raw).success
  } catch {
    return false
  }
})

/**
 * Resets cached `doesEnterpriseMcpConfigExist` state (used in tests and reloads).
 */
export function resetEnterpriseMcpConfigCache(): void {
  doesEnterpriseMcpConfigExist.cache.clear?.()
}

/**
 * Unwraps CCR session-ingress proxy URLs (`?mcp_url=...`) before signature comparison.
 */
export function unwrapCcrProxyUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (
      parsed.pathname.includes('/v2/session_ingress/shttp/mcp/') ||
      parsed.pathname.includes('/v2/ccr-sessions/')
    ) {
      const inner = parsed.searchParams.get('mcp_url')
      if (inner) {
        return inner
      }
    }
  } catch {
    // Ignore malformed URLs
  }
  return url
}

/**
 * Computes a normalized transport/endpoint signature for deduplicating identical
 * MCP servers across manual, plugin, and `claude.ai` scopes.
 */
export function getMcpServerSignature(config: McpServerConfig): string | null {
  if (config.type === 'sdk') {
    return null
  }
  if ('command' in config && (!config.type || config.type === 'stdio')) {
    return `stdio:${JSON.stringify([config.command, ...(config.args ?? [])])}`
  }
  if ('url' in config && typeof config.url === 'string') {
    const cleanUrl = unwrapCcrProxyUrl(config.url).replace(/\/+$/, '')
    return `url:${cleanUrl}`
  }
  return null
}

/**
 * Checks whether a project-scoped `.mcp.json` server is `'approved'`, `'rejected'`,
 * or `'pending'` user consent.
 */
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getInitialSettings()
  const projConfig = getCurrentProjectConfig()

  const disabled = new Set([
    ...(settings.disabledMcpjsonServers ?? []),
    ...(projConfig.disabledMcpjsonServers ?? []),
  ])
  if (disabled.has(serverName)) {
    return 'rejected'
  }

  if (
    settings.enableAllProjectMcpServers === true ||
    projConfig.enableAllProjectMcpServers === true
  ) {
    return 'approved'
  }

  const enabled = new Set([
    ...(settings.enabledMcpjsonServers ?? []),
    ...(projConfig.enabledMcpjsonServers ?? []),
  ])
  if (enabled.has(serverName)) {
    return 'approved'
  }

  return 'pending'
}

/**
 * Returns true if `serverName` has been explicitly disabled by the user for the
 * current project (or is a default-off `claude.ai` server not yet enabled).
 */
export function isMcpServerDisabled(serverName: string): boolean {
  const proj = getCurrentProjectConfig()
  if (proj.disabledMcpServers?.includes(serverName)) {
    return true
  }
  if (serverName.startsWith('claude.ai ')) {
    const globalCfg = getGlobalConfig()
    const everConnected = globalCfg.claudeAiMcpEverConnected?.includes(serverName)
    const explicitlyEnabled = proj.enabledMcpServers?.includes(serverName)
    if (!everConnected && !explicitlyEnabled) {
      return true
    }
  }
  return false
}

/**
 * Persists enabled/disabled state for `serverName` in the current project config.
 */
export function setMcpServerEnabled(
  serverName: string,
  enabled: boolean,
): void {
  saveCurrentProjectConfig(current => {
    const disabledSet = new Set(current.disabledMcpServers ?? [])
    const enabledSet = new Set(current.enabledMcpServers ?? [])
    if (enabled) {
      disabledSet.delete(serverName)
      enabledSet.add(serverName)
    } else {
      disabledSet.add(serverName)
      enabledSet.delete(serverName)
    }
    return {
      ...current,
      disabledMcpServers: Array.from(disabledSet),
      enabledMcpServers: Array.from(enabledSet),
    }
  })
}

function wildcardUrlMatches(url: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(url)
}

function matchesPolicyEntry(
  serverName: string,
  config: McpServerConfig,
  entry: AllowedMcpServerEntry,
): boolean {
  if (isMcpServerNameEntry(entry)) {
    return entry.serverName === serverName
  }
  if (isMcpServerCommandEntry(entry)) {
    if (config.type && config.type !== 'stdio') {
      return false
    }
    const actual = [config.command, ...(config.args ?? [])]
    return (
      actual.length === entry.serverCommand.length &&
      actual.every((part, idx) => part === entry.serverCommand[idx])
    )
  }
  if (isMcpServerUrlEntry(entry)) {
    if (!('url' in config)) {
      return false
    }
    return wildcardUrlMatches(config.url, entry.serverUrl)
  }
  return false
}

/**
 * Evaluates enterprise/settings `deniedMcpServers` (deny always wins) and
 * `allowedMcpServers` (`allowManagedMcpServersOnly` supported) against a server.
 */
export function isMcpServerAllowedByPolicy(
  serverName: string,
  config: McpServerConfig,
): boolean {
  if (config.type === 'sdk') {
    return true
  }

  const mergedSettings = getInitialSettings()
  const policySettings = getSettingsForSource('policySettings')

  const denied = mergedSettings.deniedMcpServers ?? []
  for (const rule of denied) {
    if (matchesPolicyEntry(serverName, config, rule)) {
      return false
    }
  }

  const allowManagedOnly = policySettings?.allowManagedMcpServersOnly === true
  const allowlist = allowManagedOnly
    ? (policySettings?.allowedMcpServers ?? [])
    : mergedSettings.allowedMcpServers

  if (allowlist === undefined) {
    return true
  }
  if (allowlist.length === 0) {
    return false
  }

  return allowlist.some(rule => matchesPolicyEntry(serverName, config, rule))
}

/**
 * Filters a map of `ScopedMcpServerConfig` entries through `isMcpServerAllowedByPolicy`.
 */
export function filterMcpServersByPolicy(
  servers: Record<string, ScopedMcpServerConfig>,
): Record<string, ScopedMcpServerConfig> {
  const filtered: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (isMcpServerAllowedByPolicy(name, config)) {
      filtered[name] = config
    } else {
      logForDebugging(`MCP server "${name}" blocked by policy`)
    }
  }
  return filtered
}

/**
 * Parses, expands `${VAR}` placeholders, and validates a single `McpServerConfig`.
 */
export function parseMcpConfig(
  serverName: string,
  rawConfig: unknown,
  scope: ConfigScope,
  pluginSource?: string,
): {
  config?: ScopedMcpServerConfig
  warnings: McpConfigWarning[]
  error?: string
} {
  const warnings: McpConfigWarning[] = []
  const validated = McpServerConfigSchema().safeParse(rawConfig)
  if (!validated.success) {
    return {
      warnings,
      error: `Invalid MCP config for "${serverName}": ${validated.error.message}`,
    }
  }

  const { expanded, missingVars } = expandEnvVarsInConfig(validated.data)
  if (missingVars.length > 0) {
    warnings.push({
      serverName,
      message: `Missing environment variable(s) in MCP server "${serverName}": ${missingVars.join(', ')}`,
    })
  }

  if (
    process.platform === 'win32' &&
    (!expanded.type || expanded.type === 'stdio') &&
    expanded.command === 'npx'
  ) {
    warnings.push({
      serverName,
      message: `Windows stdio server "${serverName}" uses "npx" directly; consider "cmd /c npx" for .cmd shim compatibility.`,
    })
  }

  return {
    config: {
      ...expanded,
      scope,
      ...(pluginSource ? { pluginSource } : {}),
    },
    warnings,
  }
}

function walkMcpJsonFilesUpward(startDir: string): string[] {
  const files: string[] = []
  let current = resolve(startDir)
  while (true) {
    const candidate = join(current, '.mcp.json')
    if (existsSync(candidate)) {
      files.push(candidate)
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  // Parent-first so deeper child `.mcp.json` overrides ancestor definitions
  return files.reverse()
}

function parseServersMap(
  rawMap: Record<string, unknown> | undefined,
  scope: ConfigScope,
): {
  servers: Record<string, ScopedMcpServerConfig>
  warnings: McpConfigWarning[]
  errors: string[]
} {
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const warnings: McpConfigWarning[] = []
  const errors: string[] = []
  if (!rawMap) {
    return { servers, warnings, errors }
  }
  for (const [name, raw] of Object.entries(rawMap)) {
    const parsed = parseMcpConfig(name, raw, scope)
    warnings.push(...parsed.warnings)
    if (parsed.error) {
      errors.push(parsed.error)
    } else if (parsed.config) {
      servers[name] = parsed.config
    }
  }
  return { servers, warnings, errors }
}

/**
 * Loads MCP servers for a single configuration scope (`enterprise`, `project`,
 * `user`, or `local`).
 */
export function getMcpConfigsByScope(scope: 'enterprise' | 'project' | 'user' | 'local'): {
  servers: Record<string, ScopedMcpServerConfig>
  warnings: McpConfigWarning[]
  errors: string[]
} {
  if (scope === 'enterprise') {
    const filePath = getEnterpriseMcpFilePath()
    if (!existsSync(filePath)) {
      return { servers: {}, warnings: [], errors: [] }
    }
    try {
      const json = JSON.parse(readFileSync(filePath, 'utf8')) as {
        mcpServers?: Record<string, unknown>
      }
      return parseServersMap(
        json.mcpServers ?? (json as Record<string, unknown>),
        'enterprise',
      )
    } catch (error) {
      return {
        servers: {},
        warnings: [],
        errors: [
          `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      }
    }
  }

  if (scope === 'project') {
    const merged: Record<string, ScopedMcpServerConfig> = {}
    const warnings: McpConfigWarning[] = []
    const errors: string[] = []
    for (const filePath of walkMcpJsonFilesUpward(getCwd())) {
      try {
        const json = JSON.parse(readFileSync(filePath, 'utf8')) as {
          mcpServers?: Record<string, unknown>
        }
        const rawServers =
          json && typeof json === 'object' && 'mcpServers' in json
            ? json.mcpServers
            : (json as Record<string, unknown>)
        const parsed = parseServersMap(rawServers, 'project')
        Object.assign(merged, parsed.servers)
        warnings.push(...parsed.warnings)
        errors.push(...parsed.errors)
      } catch (error) {
        errors.push(
          `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return { servers: merged, warnings, errors }
  }

  if (scope === 'user') {
    return parseServersMap(
      getGlobalConfig().mcpServers as Record<string, unknown> | undefined,
      'user',
    )
  }

  return parseServersMap(
    getCurrentProjectConfig().mcpServers as Record<string, unknown> | undefined,
    'local',
  )
}

/**
 * Deduplicates plugin-provided MCP servers against enabled, policy-allowed manual
 * servers and earlier plugins using `getMcpServerSignature`.
 */
export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  const sigToOwner = new Map<string, string>()
  for (const [name, cfg] of Object.entries(manualServers)) {
    if (isMcpServerDisabled(name) || !isMcpServerAllowedByPolicy(name, cfg)) {
      continue
    }
    const sig = getMcpServerSignature(cfg)
    if (sig && !sigToOwner.has(sig)) {
      sigToOwner.set(sig, name)
    }
  }

  const servers: Record<string, ScopedMcpServerConfig> = {}
  const suppressed: Array<{ name: string; duplicateOf: string }> = []
  for (const [name, cfg] of Object.entries(pluginServers)) {
    const sig = getMcpServerSignature(cfg)
    if (sig) {
      const existingOwner = sigToOwner.get(sig)
      if (existingOwner) {
        suppressed.push({ name, duplicateOf: existingOwner })
        continue
      }
      sigToOwner.set(sig, name)
    }
    servers[name] = cfg
  }
  return { servers, suppressed }
}

/**
 * Deduplicates `claude.ai` remote MCP servers whose unwrapped URL matches an
 * enabled manual server.
 */
export function dedupClaudeAiMcpServers(
  claudeAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): Record<string, ScopedMcpServerConfig> {
  const activeManualSigs = new Set<string>()
  for (const [name, cfg] of Object.entries(manualServers)) {
    if (isMcpServerDisabled(name) || !isMcpServerAllowedByPolicy(name, cfg)) {
      continue
    }
    const sig = getMcpServerSignature(cfg)
    if (sig) {
      activeManualSigs.add(sig)
    }
  }

  const out: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, cfg] of Object.entries(claudeAiServers)) {
    const sig = getMcpServerSignature(cfg)
    if (sig && activeManualSigs.has(sig)) {
      continue
    }
    out[name] = cfg
  }
  return out
}

/**
 * Parses `--mcp-config <fileOrJson...>` CLI flags into `dynamic`-scoped servers.
 */
export function parseMcpConfigsFromCli(rawEntries: readonly string[]): {
  servers: Record<string, ScopedMcpServerConfig>
  warnings: McpConfigWarning[]
  errors: string[]
} {
  const servers: Record<string, ScopedMcpServerConfig> = {}
  const warnings: McpConfigWarning[] = []
  const errors: string[] = []

  for (const entry of rawEntries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    try {
      const jsonText =
        trimmed.startsWith('{') && trimmed.endsWith('}')
          ? trimmed
          : readFileSync(resolve(getCwd(), trimmed), 'utf8')
      const raw = JSON.parse(jsonText) as {
        mcpServers?: Record<string, unknown>
      }
      const map =
        raw && typeof raw === 'object' && 'mcpServers' in raw
          ? raw.mcpServers
          : (raw as Record<string, unknown>)
      const parsed = parseServersMap(map, 'dynamic')
      Object.assign(servers, parsed.servers)
      warnings.push(...parsed.warnings)
      errors.push(...parsed.errors)
    } catch (error) {
      errors.push(
        `Failed to parse --mcp-config "${trimmed}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { servers, warnings, errors }
}

/**
 * Synchronously merges local, project (approved only), and user MCP servers,
 * honoring exclusive `managed-mcp.json` mode and `strictPluginOnlyCustomization`.
 */
export function getClaudeCodeMcpConfigs(): {
  servers: Record<string, ScopedMcpServerConfig>
  warnings: McpConfigWarning[]
  errors: string[]
} {
  if (doesEnterpriseMcpConfigExist()) {
    const ent = getMcpConfigsByScope('enterprise')
    return {
      servers: filterMcpServersByPolicy(ent.servers),
      warnings: ent.warnings,
      errors: ent.errors,
    }
  }

  if (isRestrictedToPluginOnly('mcp')) {
    return { servers: {}, warnings: [], errors: [] }
  }

  const user = getMcpConfigsByScope('user')
  const project = getMcpConfigsByScope('project')
  const local = getMcpConfigsByScope('local')

  const approvedProject: Record<string, ScopedMcpServerConfig> = {}
  for (const [name, cfg] of Object.entries(project.servers)) {
    if (getProjectMcpServerStatus(name) === 'approved') {
      approvedProject[name] = cfg
    }
  }

  const merged: Record<string, ScopedMcpServerConfig> = {
    ...user.servers,
    ...approvedProject,
    ...local.servers,
  }

  return {
    servers: filterMcpServersByPolicy(merged),
    warnings: [...user.warnings, ...project.warnings, ...local.warnings],
    errors: [...user.errors, ...project.errors, ...local.errors],
  }
}

/**
 * Asynchronously resolves the full merged MCP server map across `claude.ai`,
 * plugins, user, approved project `.mcp.json`, local, and optional CLI dynamic
 * overrides (`claudeAi < plugin < user < project < local < dynamic`).
 */
export async function getAllMcpConfigs(options?: {
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  strictMcpConfig?: boolean
  includeClaudeAi?: boolean
}): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  warnings: McpConfigWarning[]
  errors: string[]
  suppressedDuplicates: Array<{ name: string; duplicateOf: string }>
}> {
  if (doesEnterpriseMcpConfigExist()) {
    const ent = getMcpConfigsByScope('enterprise')
    return {
      servers: filterMcpServersByPolicy(ent.servers),
      warnings: ent.warnings,
      errors: ent.errors,
      suppressedDuplicates: [],
    }
  }

  if (options?.strictMcpConfig) {
    return {
      servers: filterMcpServersByPolicy(options.dynamicMcpConfig ?? {}),
      warnings: [],
      errors: [],
      suppressedDuplicates: [],
    }
  }

  const base = getClaudeCodeMcpConfigs()
  const pluginResult = pluginMcpProvider
    ? await pluginMcpProvider().catch(() => ({ servers: {}, errors: [] }))
    : { servers: {}, errors: [] }

  if (isRestrictedToPluginOnly('mcp')) {
    const dedupedPlugins = dedupPluginMcpServers(pluginResult.servers, {})
    return {
      servers: filterMcpServersByPolicy({
        ...dedupedPlugins.servers,
        ...(options?.dynamicMcpConfig ?? {}),
      }),
      warnings: [],
      errors: [...pluginResult.errors],
      suppressedDuplicates: dedupedPlugins.suppressed,
    }
  }

  const claudeAiRaw =
    options?.includeClaudeAi !== false ? await fetchClaudeAiMcpConfigs() : {}
  const dedupedClaudeAi = dedupClaudeAiMcpServers(claudeAiRaw, base.servers)
  const dedupedPlugin = dedupPluginMcpServers(
    pluginResult.servers,
    base.servers,
  )

  const combined: Record<string, ScopedMcpServerConfig> = {
    ...dedupedClaudeAi,
    ...dedupedPlugin.servers,
    ...base.servers,
    ...(options?.dynamicMcpConfig ?? {}),
  }

  return {
    servers: filterMcpServersByPolicy(combined),
    warnings: base.warnings,
    errors: [...base.errors, ...pluginResult.errors],
    suppressedDuplicates: dedupedPlugin.suppressed,
  }
}

/**
 * Describes the physical file location for a given MCP configuration scope.
 */
export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'enterprise':
    case 'managed':
      return getEnterpriseMcpFilePath()
    case 'project':
      return join(getCwd(), '.mcp.json')
    case 'user':
    case 'local':
      return '~/.copilot.json'
    case 'claudeai':
      return 'claude.ai remote connector'
    case 'dynamic':
      return 'session / plugin dynamic config'
  }
}

/**
 * Adds or updates an MCP server definition in `'local'`, `'user'`, or `'project'`
 * scope. Rejects mutations when enterprise `managed-mcp.json` is active.
 */
export function addMcpConfig(
  name: string,
  rawConfig: McpServerConfig,
  scope: 'local' | 'user' | 'project' = 'local',
): void {
  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      'Cannot modify MCP servers: enterprise managed-mcp.json is active',
    )
  }
  const validated = McpServerConfigSchema().parse(rawConfig)

  if (scope === 'project') {
    const filePath = join(getCwd(), '.mcp.json')
    let existing: { mcpServers: Record<string, McpServerConfig> } = {
      mcpServers: {},
    }
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
        mcpServers?: Record<string, McpServerConfig>
      }
      existing = {
        mcpServers: { ...(parsed.mcpServers ?? {}) },
      }
    }
    existing.mcpServers[name] = validated
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tmpPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
    return
  }

  if (scope === 'user') {
    saveGlobalConfig(current => ({
      ...current,
      mcpServers: {
        ...(current.mcpServers ?? {}),
        [name]: validated,
      },
    }))
    return
  }

  saveCurrentProjectConfig(current => ({
    ...current,
    mcpServers: {
      ...(current.mcpServers ?? {}),
      [name]: validated,
    },
  }))
}

/**
 * Removes an MCP server from `'local'`, `'user'`, or `'project'` scope.
 * Returns `true` if the server existed and was removed.
 */
export function removeMcpConfig(
  name: string,
  scope?: 'local' | 'user' | 'project',
): { removed: boolean; scope?: 'local' | 'user' | 'project' } {
  if (doesEnterpriseMcpConfigExist()) {
    throw new Error(
      'Cannot modify MCP servers: enterprise managed-mcp.json is active',
    )
  }

  if (!scope) {
    const presentIn: Array<'local' | 'project' | 'user'> = []
    for (const candidate of ['local', 'project', 'user'] as const) {
      if (name in getMcpConfigsByScope(candidate).servers) {
        presentIn.push(candidate)
      }
    }
    if (presentIn.length === 0) {
      return { removed: false }
    }
    if (presentIn.length > 1) {
      throw new Error(
        `MCP server "${name}" exists in multiple scopes (${presentIn.join(', ')}). Specify --scope <${presentIn.join('|')}>.`,
      )
    }
    scope = presentIn[0]!
  }

  if (scope === 'project') {
    const filePath = join(getCwd(), '.mcp.json')
    if (!existsSync(filePath)) {
      return { removed: false }
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      mcpServers?: Record<string, McpServerConfig>
    }
    if (!parsed.mcpServers || !(name in parsed.mcpServers)) {
      return { removed: false }
    }
    const nextServers = { ...parsed.mcpServers }
    delete nextServers[name]
    const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(
      tmpPath,
      `${JSON.stringify({ ...parsed, mcpServers: nextServers }, null, 2)}\n`,
      'utf8',
    )
    renameSync(tmpPath, filePath)
    return { removed: true, scope: 'project' }
  }

  if (scope === 'user') {
    const current = getGlobalConfig()
    if (!current.mcpServers || !(name in current.mcpServers)) {
      return { removed: false }
    }
    saveGlobalConfig(prev => {
      const next = { ...(prev.mcpServers ?? {}) }
      delete next[name]
      return { ...prev, mcpServers: next }
    })
    return { removed: true, scope: 'user' }
  }

  const current = getCurrentProjectConfig()
  if (!current.mcpServers || !(name in current.mcpServers)) {
    return { removed: false }
  }
  saveCurrentProjectConfig(prev => {
    const next = { ...(prev.mcpServers ?? {}) }
    delete next[name]
    return { ...prev, mcpServers: next }
  })
  return { removed: true, scope: 'local' }
}

/**
 * Looks up a configured MCP server by name across local, project, user, and
 * enterprise scopes.
 */
export function getMcpConfigByName(
  name: string,
): ScopedMcpServerConfig | undefined {
  if (doesEnterpriseMcpConfigExist()) {
    return getMcpConfigsByScope('enterprise').servers[name]
  }
  for (const scope of ['local', 'project', 'user'] as const) {
    const found = getMcpConfigsByScope(scope).servers[name]
    if (found) {
      return found
    }
  }
  return undefined
}
