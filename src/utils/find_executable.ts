import { whichSync } from './which.js'

/**
 * Find an executable by searching PATH, similar to `which`.
 * Returns `{ cmd, args }` where `cmd` is the resolved path if found,
 * or the original name if not.
 */
export function findExecutable(
  executable: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(executable)
  return { cmd: resolved ?? executable, args }
}
