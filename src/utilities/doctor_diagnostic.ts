import { existsSync } from 'fs'
import { getMacroVersion } from '../constants/version.js'
import { loadKeybindingsSyncWithWarnings } from '../keybindings/load_user_bindings.js'
import { getCwd } from './cwd.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { getSettingsWithErrors } from './settings/settings.js'

export type DiagnosticCheckStatus = 'pass' | 'warn' | 'fail'

export type DiagnosticCheckItem = {
  id: string
  label: string
  status: DiagnosticCheckStatus
  detail: string
}

export type DoctorReport = {
  version: string
  platform: string
  runtime: string
  cwd: string
  configDir: string
  checks: DiagnosticCheckItem[]
  allPassed: boolean
  hasFailures: boolean
}

/**
 * Run comprehensive `/doctor` environment, config, settings schema,
 * keybindings, and workspace health diagnostics.
 */
export function runDoctorDiagnostics(options?: {
  cwd?: string
  configDir?: string
}): DoctorReport {
  const cwd = options?.cwd ?? getCwd()
  const configDir = options?.configDir ?? getClaudeConfigHomeDir()
  const checks: DiagnosticCheckItem[] = []

  // 1. Runtime & Version
  const runtime =
    typeof process.versions.bun === 'string'
      ? `Bun ${process.versions.bun}`
      : `Node ${process.version}`
  checks.push({
    id: 'runtime',
    label: 'Runtime environment',
    status: 'pass',
    detail: `${runtime} on ${process.platform} (${process.arch})`,
  })

  // 2. Workspace CWD
  const cwdOk = existsSync(cwd)
  checks.push({
    id: 'workspace',
    label: 'Working directory',
    status: cwdOk ? 'pass' : 'fail',
    detail: cwdOk ? cwd : `Missing directory: ${cwd}`,
  })

  // 3. Config directory
  checks.push({
    id: 'config-dir',
    label: 'Configuration directory',
    status: 'pass',
    detail: existsSync(configDir)
      ? `${configDir} (present)`
      : `${configDir} (will be created on first save)`,
  })

  // 4. Settings schema validation
  const { errors: settingsErrors } = getSettingsWithErrors()
  checks.push({
    id: 'settings-schema',
    label: 'Settings validation',
    status: settingsErrors.length === 0 ? 'pass' : 'warn',
    detail:
      settingsErrors.length === 0
        ? 'All settings files valid'
        : `${settingsErrors.length} validation warning(s): ${settingsErrors[0]?.message}`,
  })

  // 5. Keybindings validation
  const kb = loadKeybindingsSyncWithWarnings()
  checks.push({
    id: 'keybindings',
    label: 'Keybindings configuration',
    status: kb.warnings.length === 0 ? 'pass' : 'warn',
    detail:
      kb.warnings.length === 0
        ? 'Keybindings valid'
        : `${kb.warnings.length} keybinding warning(s)`,
  })

  // 6. Auth / API credentials check (non-failing info/pass)
  const hasApiKey = Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.COPILOT_CLI_API_KEY,
  )
  checks.push({
    id: 'auth',
    label: 'API credentials',
    status: 'pass',
    detail: hasApiKey
      ? 'Environment API key detected'
      : 'Using configured/OAuth credentials (or mock in tests)',
  })

  // 7. Terminal capabilities
  checks.push({
    id: 'terminal',
    label: 'Terminal capabilities',
    status: 'pass',
    detail: `TERM=${process.env.TERM ?? 'unknown'} · ${process.stdout.columns ?? 80}x${process.stdout.rows ?? 24}`,
  })

  const hasFailures = checks.some(c => c.status === 'fail')
  const allPassed = checks.every(c => c.status === 'pass')

  return {
    version: getMacroVersion(),
    platform: process.platform,
    runtime,
    cwd,
    configDir,
    checks,
    allPassed,
    hasFailures,
  }
}

export function formatDoctorReportText(report: DoctorReport): string {
  const lines = [
    `Copilot CLI Doctor v${report.version}`,
    ...report.checks.map(c => {
      const icon = c.status === 'pass' ? '✓' : c.status === 'warn' ? '⚠' : '✗'
      return `  ${icon} ${c.label}: ${c.detail}`
    }),
  ]
  return lines.join('\n')
}
