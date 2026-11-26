import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

/**
 * Runs a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) see
 * the overridden working directory without mutating global process state.
 */
export function runWithCwdOverride<Result>(
  directory: string,
  fn: () => Result,
): Result {
  return cwdOverrideStorage.run(directory, fn)
}

/**
 * Gets the current working directory.
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/**
 * Gets the current working directory, falling back to originalCwd if unavailable.
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
