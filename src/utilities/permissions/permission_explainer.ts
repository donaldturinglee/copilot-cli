/**
 * Deterministic risk explainer for interactive permission prompts and audit logs.
 */

import type {
  PermissionExplanation,
  RiskLevel,
} from '../../types/permissions.js'

const HIGH_RISK_RE =
  /\b(?:rm\s+-rf|sudo|mkfs|dd\s+if=|git\s+push\s+--force|git\s+reset\s+--hard|curl.*\|\s*(?:sh|bash)|iex|invoke-expression|chmod\s+777)\b/i

const MEDIUM_RISK_RE =
  /\b(?:git\s+push|git\s+commit|npm\s+publish|rm\s|mv\s|chmod|chown|kill|remove-item)\b/i

export function explainToolPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
): PermissionExplanation {
  const command =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : JSON.stringify(input)

  let riskLevel: RiskLevel = 'LOW'
  let risk = 'Scoped operation within the current workspace.'

  if (HIGH_RISK_RE.test(command)) {
    riskLevel = 'HIGH'
    risk =
      'Command may cause irreversible data loss, privilege escalation, or arbitrary code execution.'
  } else if (
    toolName === 'Bash' ||
    toolName === 'PowerShell' ||
    MEDIUM_RISK_RE.test(command)
  ) {
    riskLevel = 'MEDIUM'
    risk = 'Shell or file mutation operation with side effects.'
  }

  return {
    riskLevel,
    explanation: `${toolName}: ${command.slice(0, 200)}`,
    reasoning: `Evaluated statically for tool ${toolName}.`,
    risk,
  }
}
