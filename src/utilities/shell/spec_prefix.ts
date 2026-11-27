/**
 * Spec-oriented command prefix normalization used for permission rule
 * suggestion generation.
 */

import { extractCommandPrefix } from './prefix.js'

export function extractSpecPrefix(command: string): string | null {
  const prefix = extractCommandPrefix(command)
  return prefix.length > 0 ? prefix : null
}
