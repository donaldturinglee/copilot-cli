import { getEventLogger, getPromptId } from '../../bootstrap/state.js'
import type { OtelAttributes } from '../../types/forward.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../env_utils.js'

let eventSequence = 0
let hasWarnedNoEventLogger = false
let telemetryAttributesProvider: (() => OtelAttributes) | undefined

export function registerTelemetryAttributesProvider(
  provider: () => OtelAttributes,
): void {
  telemetryAttributesProvider = provider
}

function isUserPromptLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
}

export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}

export async function logOtelEvent(
  eventName: string,
  metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  const eventLogger = getEventLogger()
  if (!eventLogger) {
    if (!hasWarnedNoEventLogger) {
      hasWarnedNoEventLogger = true
      logForDebugging(
        `[3P telemetry] Event dropped (no event logger initialized): ${eventName}`,
        { level: 'warn' },
      )
    }
    return
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  const attributes: OtelAttributes = {
    ...(telemetryAttributesProvider?.() ?? {}),
    'event.name': eventName,
    'event.timestamp': new Date().toISOString(),
    'event.sequence': eventSequence++,
  }

  const promptId = getPromptId()
  if (promptId) {
    attributes['prompt.id'] = promptId
  }

  const workspaceDir = process.env.COPILOT_CLI_WORKSPACE_HOST_PATHS
  if (workspaceDir) {
    attributes['workspace.host_paths'] = workspaceDir.split('|')
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      attributes[key] = value
    }
  }

  eventLogger.emit({
    body: `copilot_cli.${eventName}`,
    attributes,
  })
}
