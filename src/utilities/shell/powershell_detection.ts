/**
 * PowerShell executable detection (`pwsh` preferred over Windows PowerShell
 * `powershell.exe`) with memoized lookup and edition classification.
 */

import { basename } from 'path'
import { getPlatform } from '../platform.js'
import { whichSync } from '../which.js'

export type PowerShellEdition = 'core' | 'desktop'

export interface DetectedPowerShell {
  path: string
  edition: PowerShellEdition
}

let cachedDetection: DetectedPowerShell | null | undefined

/**
 * Locates `pwsh` (PowerShell 7+) or `powershell` (Windows PowerShell 5.1).
 */
export function findPowerShell(): DetectedPowerShell | null {
  if (cachedDetection !== undefined) {
    return cachedDetection
  }

  const pwsh = whichSync('pwsh')
  if (pwsh) {
    cachedDetection = { path: pwsh, edition: 'core' }
    return cachedDetection
  }

  if (getPlatform() === 'windows') {
    const ps = whichSync('powershell') || whichSync('powershell.exe')
    if (ps) {
      cachedDetection = { path: ps, edition: 'desktop' }
      return cachedDetection
    }
  }

  cachedDetection = null
  return null
}

export function getCachedPowerShellPath(): string | null {
  return findPowerShell()?.path ?? null
}

export function getPowerShellEdition(exePath?: string): PowerShellEdition {
  if (exePath) {
    const base = basename(exePath).toLowerCase()
    return base.startsWith('pwsh') ? 'core' : 'desktop'
  }
  return findPowerShell()?.edition ?? 'desktop'
}

export function resetPowerShellCache(): void {
  cachedDetection = undefined
}
