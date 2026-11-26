import { randomBytes, type UUID } from 'crypto'
import type { AgentId } from 'src/types/ids.js'

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate uuid
 * @param maybeUuid The value to be checked if it is a uuid
 * @returns string as UUID or null if it is not valid
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  if (typeof maybeUuid !== 'string') return null
  return UUID_REGEX.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * Generate a new agent ID with prefix for consistency with task IDs.
 * Format: a{label-}{16 hex chars}
 */
export function createAgentId(label?: string): AgentId {
  const suffix = randomBytes(8).toString('hex')
  return (label ? `a${label}-${suffix}` : `a${suffix}`) as AgentId
}
