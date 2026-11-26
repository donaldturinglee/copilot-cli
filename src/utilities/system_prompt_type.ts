/**
 * Strictly dependency-free branded `SystemPrompt` array type.
 */

export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

/**
 * Brands a readonly string array as a `SystemPrompt`.
 */
export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
