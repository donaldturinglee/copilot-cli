/**
 * Cross-platform shell provider abstraction (`BashProvider` / `PowerShellProvider`).
 */

export const SHELL_TYPES = ['bash', 'powershell'] as const
export type ShellKind = (typeof SHELL_TYPES)[number]

export interface ShellCommandBuildOptions {
  command: string
  cwdFile: string
  snapshotPath?: string
  envFiles?: readonly string[]
  shellPrefix?: string
  useLoginShell?: boolean
}

export interface ShellProvider {
  readonly kind: ShellKind
  readonly shellPath: string
  buildCommand(options: ShellCommandBuildOptions): string
  getSpawnArgs(script: string, options?: { hasSnapshot?: boolean; encoded?: boolean }): string[]
}
