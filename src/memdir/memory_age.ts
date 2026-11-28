/**
 * Memory age formatting and point-in-time staleness reminders for recalled
 * topic memory files.
 */

const MS_PER_DAY = 86_400_000

/**
 * Returns the non-negative whole-day age of a memory file from its `mtimeMs`.
 */
export function memoryAgeDays(mtimeMs: number): number {
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / MS_PER_DAY))
}

/**
 * Formats a human-readable relative age label (`today`, `yesterday`, `N days ago`).
 */
export function memoryAge(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days === 0) {
    return 'today'
  }
  if (days === 1) {
    return 'yesterday'
  }
  return `${days} days ago`
}

/**
 * Returns a plain-text staleness caveat when a memory file is older than 1 day,
 * or an empty string for fresh memories (`<= 1` day old).
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const days = memoryAgeDays(mtimeMs)
  if (days <= 1) {
    return ''
  }
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`
}

/**
 * Wraps `memoryFreshnessText` in a `<system-reminder>` header for tool/file
 * reads, returning an empty string for fresh memories.
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) {
    return ''
  }
  return `<system-reminder>${text}</system-reminder>\n`
}
