/**
 * Structured permission decision telemetry & debug logging.
 */

import { logEvent } from '../../services/analytics/index.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { logForDebugging } from '../../utilities/debug.js'

export function logPermissionDecision(
  toolName: string,
  decision: PermissionDecision<Record<string, unknown>>,
): void {
  const reasonType = decision.decisionReason?.type ?? 'unknown'
  logForDebugging(
    `Permission [${decision.behavior}] for ${toolName} (reason=${reasonType})`,
  )
  logEvent('tengu_tool_permission_decision', {
    allowed: decision.behavior === 'allow',
    denied: decision.behavior === 'deny',
    asked: decision.behavior === 'ask',
  })
}
