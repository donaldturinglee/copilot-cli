import { logForDebugging } from '../utilities/debug.js'

const seenWarnings = new Set<string>()

export function warnOnce(key: string, message: string): void {
  if (seenWarnings.has(key)) return
  seenWarnings.add(key)
  logForDebugging(`[ink warn] ${message}`)
}

export function resetWarnings(): void {
  seenWarnings.clear()
}
