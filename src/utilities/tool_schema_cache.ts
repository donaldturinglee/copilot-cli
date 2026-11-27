/**
 * Session-scoped cache for serialized API tool schemas.
 * Registered with auth cache invalidation so model/provider/auth transitions
 * cleanly flush stale tool definitions.
 */

import { registerAuthCacheInvalidator } from './auth.js'

export interface CachedApiToolSchema {
  name: string
  description: string
  input_schema: Record<string, unknown>
  strict?: boolean
  eager_input_streaming?: boolean
}

const toolSchemaCache = new Map<string, CachedApiToolSchema>()

/**
 * Returns the session-scoped tool schema serialization cache.
 */
export function getToolSchemaCache(): Map<string, CachedApiToolSchema> {
  return toolSchemaCache
}

/**
 * Clears all cached tool-to-API schema entries.
 */
export function clearToolSchemaCache(): void {
  toolSchemaCache.clear()
}

registerAuthCacheInvalidator(clearToolSchemaCache)
