import { getAllowedSettingSources } from '../../bootstrap/state.js'

export const SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

export type SettingSource = (typeof SETTING_SOURCES)[number]

export type EditableSettingSource = Exclude<
  SettingSource,
  'policySettings' | 'flagSettings'
>

export const SOURCES = [
  'localSettings',
  'projectSettings',
  'userSettings',
] as const satisfies readonly EditableSettingSource[]

export const COPILOT_CLI_SETTINGS_SCHEMA_URL =
  'https://json.schemastore.org/claude-code-settings.json'

export function getSettingSourceName(source: SettingSource): string {
  switch (source) {
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'project, gitignored'
    case 'flagSettings':
      return 'cli flag'
    case 'policySettings':
      return 'managed'
  }
}

export function getSourceDisplayName(
  source: SettingSource | 'plugin' | 'built-in',
): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'flagSettings':
      return 'Flag'
    case 'policySettings':
      return 'Managed'
    case 'plugin':
      return 'Plugin'
    case 'built-in':
      return 'Built-in'
  }
}

export function getSettingSourceDisplayNameLowercase(
  source: SettingSource | 'cliArg' | 'command' | 'session',
): string {
  switch (source) {
    case 'userSettings':
      return 'user settings'
    case 'projectSettings':
      return 'project settings'
    case 'localSettings':
      return 'local settings'
    case 'flagSettings':
      return 'flag settings'
    case 'policySettings':
      return 'managed settings'
    case 'cliArg':
      return 'CLI argument'
    case 'command':
      return 'command'
    case 'session':
      return 'session'
  }
}

export function getSettingSourceDisplayNameCapitalized(
  source: SettingSource | 'cliArg' | 'command' | 'session',
): string {
  const lower = getSettingSourceDisplayNameLowercase(source)
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

const SHORT_TO_FULL_SOURCE: Record<string, SettingSource> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

export function parseSettingSourcesFlag(flag: string): SettingSource[] {
  const trimmed = flag.trim()
  if (trimmed === '') {
    return []
  }

  const parts = trimmed
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
  const sources: SettingSource[] = []

  for (const part of parts) {
    const mapped = SHORT_TO_FULL_SOURCE[part]
    if (!mapped) {
      throw new Error(
        `Invalid setting source: "${part}". Valid values: ${Object.keys(SHORT_TO_FULL_SOURCE).join(', ')}`,
      )
    }
    if (!sources.includes(mapped)) {
      sources.push(mapped)
    }
  }

  return sources
}

export function getEnabledSettingSources(): SettingSource[] {
  const allowed = new Set<SettingSource>(getAllowedSettingSources())
  allowed.add('policySettings')
  allowed.add('flagSettings')
  return SETTING_SOURCES.filter(source => allowed.has(source))
}

export function isSettingSourceEnabled(source: SettingSource): boolean {
  return getEnabledSettingSources().includes(source)
}
