/**
 * PowerShell execution provider supporting both Windows PowerShell 5.1 and
 * PowerShell 7+ (`pwsh`), UTF-16LE `-EncodedCommand` invocation, exit-code
 * capture, and CWD persistence.
 */

import type { ShellCommandBuildOptions, ShellProvider } from './shell_provider.js'

function escapePsSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

/**
 * Builds PowerShell CLI spawn arguments (`-NoProfile -NonInteractive`), using
 * base64 UTF-16LE `-EncodedCommand` by default to eliminate quoting issues.
 */
export function buildPowerShellArgs(
  script: string,
  options?: { encoded?: boolean },
): string[] {
  const base = ['-NoProfile', '-NonInteractive']
  if (options?.encoded !== false) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return [...base, '-EncodedCommand', encoded]
  }
  return [...base, '-Command', script]
}

export class PowerShellProvider implements ShellProvider {
  readonly kind = 'powershell' as const
  readonly shellPath: string

  constructor(shellPath: string) {
    this.shellPath = shellPath
  }

  buildCommand(options: ShellCommandBuildOptions): string {
    const escapedCwdFile = escapePsSingleQuoted(options.cwdFile)
    const lines: string[] = [
      '$ErrorActionPreference = "Continue"',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '$global:LASTEXITCODE = 0',
      'try {',
      options.command,
      '  $__copilot_ok = $?',
      '  $__copilot_ec = if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { [int]$global:LASTEXITCODE } elseif (-not $__copilot_ok) { 1 } else { 0 }',
      '} catch {',
      '  [Console]::Error.WriteLine($_.Exception.Message)',
      '  $__copilot_ec = 1',
      '} finally {',
      `  try { [System.IO.File]::WriteAllText('${escapedCwdFile}', (Get-Location).Path, [System.Text.UTF8Encoding]::new($false)) } catch {}`,
      '}',
      'exit $__copilot_ec',
    ]
    return lines.join('\n')
  }

  getSpawnArgs(
    script: string,
    options?: { encoded?: boolean },
  ): string[] {
    return buildPowerShellArgs(script, { encoded: options?.encoded ?? true })
  }
}
