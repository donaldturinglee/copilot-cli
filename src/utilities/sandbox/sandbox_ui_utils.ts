/**
 * User-facing sandbox status and violation formatting helpers.
 */

import { SandboxManager } from './sandbox_adapter.js'

export function formatSandboxStatusSummary(): string {
  if (SandboxManager.isSandboxingEnabled()) {
    const autoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
      ? 'auto-allow on'
      : 'prompt on'
    const locked = SandboxManager.areSandboxSettingsLockedByPolicy()
      ? ' (locked by policy)'
      : ''
    return `Sandbox: enabled (${autoAllow})${locked}`
  }
  const unavailable = SandboxManager.getSandboxUnavailableReason()
  return unavailable
    ? `Sandbox: unavailable (${unavailable})`
    : 'Sandbox: disabled'
}

export function formatSandboxViolationNotice(command: string): string | null {
  const store = SandboxManager.getSandboxViolationStore()
  const violations = store.getViolationsForCommand(command)
  if (violations.length === 0) return null
  const lines = violations.slice(0, 5).map(v => `  - ${v.line}`)
  return `Sandbox blocked ${violations.length} operation(s):\n${lines.join('\n')}`
}
