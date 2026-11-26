/**
 * Disk-cached model capabilities lookup (ant-only 1P endpoint `/v1/models`).
 */

import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { getClaudeConfigHomeDir } from '../env_utils.js'
import { getFsImplementation } from '../fs_operations.js'
import { jsonParse, jsonStringify } from '../slow_operations.js'

const ModelCapabilityEntrySchema = z.object({
  id: z.string(),
  max_input_tokens: z.number().optional(),
  max_tokens: z.number().optional(),
})

const ModelCapabilitiesCacheSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(ModelCapabilityEntrySchema),
})

export type ModelCapability = z.infer<typeof ModelCapabilityEntrySchema>

let cachedCapabilities: ModelCapability[] | null = null

function getCapabilitiesCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'model-capabilities.json')
}

function loadCapabilitiesFromDisk(): ModelCapability[] {
  if (cachedCapabilities !== null) {
    return cachedCapabilities
  }
  if (process.env.USER_TYPE !== 'ant') {
    cachedCapabilities = []
    return cachedCapabilities
  }
  try {
    const raw = getFsImplementation().readFileSync(getCapabilitiesCachePath(), {
      encoding: 'utf-8',
    })
    const parsed = ModelCapabilitiesCacheSchema.safeParse(jsonParse(raw))
    if (parsed.success) {
      // Longest ID first so exact/more-specific IDs match before prefixes
      cachedCapabilities = [...parsed.data.models].sort(
        (a, b) => b.id.length - a.id.length,
      )
      return cachedCapabilities
    }
  } catch {
    // Cache absent or malformed
  }
  cachedCapabilities = []
  return cachedCapabilities
}

/**
 * Saves fetched model capabilities to `{configDir}/cache/model-capabilities.json` (0o600).
 */
export function saveModelCapabilitiesCache(models: ModelCapability[]): void {
  const sorted = [...models].sort((a, b) => b.id.length - a.id.length)
  cachedCapabilities = sorted
  try {
    const cachePath = getCapabilitiesCachePath()
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(
      cachePath,
      jsonStringify({ fetchedAt: Date.now(), models: sorted }),
      { encoding: 'utf-8', mode: 0o600 },
    )
  } catch {
    // Non-fatal cache write error
  }
}

/**
 * Looks up cached capability metadata (`max_input_tokens`, `max_tokens`) for a model.
 */
export function getModelCapability(model: string): ModelCapability | undefined {
  const models = loadCapabilitiesFromDisk()
  if (models.length === 0) {
    return undefined
  }
  const normalized = model.replace(/\[(1|2)m\]/gi, '').toLowerCase()
  return (
    models.find(m => m.id.toLowerCase() === normalized) ??
    models.find(m => normalized.includes(m.id.toLowerCase()))
  )
}

/**
 * Clears in-memory model capabilities cache for tests.
 */
export function resetModelCapabilitiesCacheForTesting(): void {
  cachedCapabilities = null
}
