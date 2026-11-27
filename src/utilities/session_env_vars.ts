/**
 * In-memory session environment variable overrides merged into spawned shell
 * environments.
 */

const sessionEnvVars = new Map<string, string>()

export function setSessionEnvVar(key: string, value: string): void {
  sessionEnvVars.set(key, value)
}

export function getSessionEnvVars(): Record<string, string> {
  return Object.fromEntries(sessionEnvVars.entries())
}

export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
