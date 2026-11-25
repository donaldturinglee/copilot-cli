/**
 * Branded types for session and agent IDs.
 * These prevent accidentally mixing up session IDs and agent IDs at compile time.
 */

declare const SESSION_ID_BRAND: unique symbol
declare const AGENT_ID_BRAND: unique symbol

export type SessionId = string & { readonly [SESSION_ID_BRAND]: 'SessionId' }

export type AgentId = string & { readonly [AGENT_ID_BRAND]: 'AgentId' }

export function asSessionId(id: string): SessionId {
  return id as SessionId
}

export function asAgentId(id: string): AgentId {
  return id as AgentId
}

const AGENT_ID_PATTERN = /^a(?:.+-)?[0-9a-f]{16}$/

/**
 * Validate and brand a string as AgentId.
 * Matches the format produced by createAgentId(): `a` + optional `<label>-` + 16 hex chars.
 */
export function toAgentId(value: string): AgentId | null {
  return AGENT_ID_PATTERN.test(value) ? (value as AgentId) : null
}
