/**
 * User-facing model alias constants and type guards.
 */

export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const

export type ModelAlias = (typeof MODEL_ALIASES)[number]

export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

export type ModelFamilyAlias = (typeof MODEL_FAMILY_ALIASES)[number]

/**
 * Returns true if `value` is a recognized model alias (case-insensitive).
 */
export function isModelAlias(value: string): value is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(value.toLowerCase())
}

/**
 * Returns true if `value` is a bare model family alias (`sonnet`, `opus`, `haiku`).
 */
export function isModelFamilyAlias(value: string): value is ModelFamilyAlias {
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(
    value.toLowerCase(),
  )
}
