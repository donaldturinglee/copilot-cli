/**
 * PowerShell bare-repository TOCTOU & `.git` internal path defense.
 *
 * Defends against planting bare-repo markers (`HEAD`, `objects`, `refs`,
 * `hooks`, `config`) or `.git` internals in the same compound command before
 * running `git`, including:
 * - Case-insensitivity (`head`, `HOOKS`)
 * - Trailing dots/spaces on NTFS (`.git.`, `hooks `)
 * - NTFS 8.3 short filenames (`GIT~1`, `OBJECT~1`)
 * - PowerShell provider prefixes (`FileSystem::hooks`, `Microsoft.PowerShell.Core\FileSystem::...`)
 * - Directory re-entry (`../<cwd-basename>/hooks`)
 */

import { isAbsolute, normalize, relative, resolve } from 'path'
import { getCwd } from '../../utilities/cwd.js'

const BARE_REPO_TOP_SEGMENTS = new Set([
  'head',
  'objects',
  'refs',
  'hooks',
  'config',
])

const NTFS_SHORT_NAME_RE = /~\d+(?:\.[^./\\]+)?$/

function stripPowerShellProviderPrefix(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/^['"]|['"]$/g, '')
  const providerIdx = cleaned.indexOf('::')
  if (providerIdx !== -1) {
    return cleaned.slice(providerIdx + 2)
  }
  return cleaned
}

function normalizeSegmentForWindows(seg: string): string {
  // Strip NTFS trailing dots and spaces
  return seg.replace(/[. ]+$/, '').toLowerCase()
}

/**
 * Returns true if `rawPath` targets `.git` (or any path inside `.git`),
 * including NTFS trailing-dot / 8.3 short-name bypasses.
 */
export function isDotGitPathPs(rawPath: string, cwd: string = getCwd()): boolean {
  const stripped = stripPowerShellProviderPrefix(rawPath)
  if (!stripped) return false

  const rawSegments = stripped.split(/[\\/]+/).filter(Boolean)
  for (const seg of rawSegments) {
    const norm = normalizeSegmentForWindows(seg)
    if (norm === '.git' || (NTFS_SHORT_NAME_RE.test(seg) && norm.includes('git'))) {
      return true
    }
  }

  const resolved = isAbsolute(stripped) ? normalize(stripped) : resolve(cwd, stripped)
  const resolvedSegments = resolved.split(/[\\/]+/).filter(Boolean)
  return resolvedSegments.some(s => normalizeSegmentForWindows(s) === '.git')
}

/**
 * Returns true if `rawPath` targets `.git` OR any bare-repo marker at the root
 * of `cwd` (`HEAD`, `objects`, `refs`, `hooks`, `config`), defeating TOCTOU
 * attacks like `New-Item HEAD; git status` or `Set-Content ../repo/hooks/pre-commit ...; git status`.
 */
export function isGitInternalPathPs(
  rawPath: string,
  cwd: string = getCwd(),
): boolean {
  if (isDotGitPathPs(rawPath, cwd)) {
    return true
  }

  const stripped = stripPowerShellProviderPrefix(rawPath)
  if (!stripped) return false

  // Catch NTFS 8.3 short names that could alias objects/hooks/config
  const rawSegments = stripped.split(/[\\/]+/).filter(Boolean)
  if (rawSegments.some(seg => NTFS_SHORT_NAME_RE.test(seg))) {
    return true
  }

  // Resolve against cwd to catch `../<cwd>/hooks` re-entry
  const resolved = isAbsolute(stripped) ? normalize(stripped) : resolve(cwd, stripped)
  const rel = relative(resolve(cwd), resolved)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    const firstSeg = rel.split(/[\\/]+/).filter(Boolean)[0]
    if (firstSeg && BARE_REPO_TOP_SEGMENTS.has(normalizeSegmentForWindows(firstSeg))) {
      return true
    }
  }

  return false
}
