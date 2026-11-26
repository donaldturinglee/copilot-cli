/**
 * Enterprise `settings.availableModels` allowlist enforcement with family
 * wildcard narrowing and version-prefix matching.
 */

import { getInitialSettings } from '../settings/settings.js'
import { isModelFamilyAlias, MODEL_FAMILY_ALIASES } from './aliases.js'

function stripContextSuffix(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '').trim().toLowerCase()
}

function detectFamily(model: string): 'opus' | 'sonnet' | 'haiku' | null {
  const normalized = stripContextSuffix(model)
  if (normalized === 'opus' || normalized.includes('opus')) return 'opus'
  if (normalized === 'sonnet' || normalized.includes('sonnet')) return 'sonnet'
  if (normalized === 'haiku' || normalized.includes('haiku')) return 'haiku'
  return null
}

function normalizeVersionToken(entry: string): string {
  return stripContextSuffix(entry).replace(/^claude-/, '')
}

function matchesSegmentPrefix(candidate: string, pattern: string): boolean {
  const normalizedCandidate = normalizeVersionToken(candidate)
  const normalizedPattern = normalizeVersionToken(pattern)
  if (normalizedCandidate === normalizedPattern) {
    return true
  }
  if (normalizedCandidate.startsWith(`${normalizedPattern}-`)) {
    return true
  }
  if (normalizedCandidate.startsWith(`${normalizedPattern}@`)) {
    return true
  }
  return false
}

/**
 * Returns true if `model` is permitted by `settings.availableModels`.
 * - Undefined allowlist permits all models.
 * - Empty allowlist denies all models.
 * - Bare family aliases (`opus`/`sonnet`/`haiku`) act as wildcards UNLESS the
 *   allowlist also specifies version-narrowed entries for that same family.
 */
export function isModelAllowed(
  model: string,
  availableModels: readonly string[] | undefined = getInitialSettings()
    .availableModels,
): boolean {
  if (availableModels === undefined) {
    return true
  }
  if (availableModels.length === 0) {
    return false
  }

  const candidateNormalized = stripContextSuffix(model)
  const candidateFamily = detectFamily(model)

  const narrowedFamilies = new Set<string>()
  for (const entry of availableModels) {
    const norm = stripContextSuffix(entry)
    if (isModelFamilyAlias(norm)) {
      continue
    }
    const family = detectFamily(norm)
    if (family && !isModelFamilyAlias(norm) && norm !== 'opusplan') {
      narrowedFamilies.add(family)
    }
  }

  for (const entry of availableModels) {
    const entryNorm = stripContextSuffix(entry)

    if (entryNorm === candidateNormalized) {
      return true
    }

    // Family wildcard (when not narrowed by version-specific entries in the same family)
    if (
      (MODEL_FAMILY_ALIASES as readonly string[]).includes(entryNorm) &&
      candidateFamily === entryNorm &&
      !narrowedFamilies.has(entryNorm)
    ) {
      return true
    }

    // Non-family alias match (e.g. opusplan, best)
    if (entryNorm === 'opusplan' && candidateNormalized === 'opusplan') {
      return true
    }

    // Segment-boundary version prefix match
    if (
      !isModelFamilyAlias(entryNorm) &&
      matchesSegmentPrefix(candidateNormalized, entryNorm)
    ) {
      return true
    }
  }

  return false
}
