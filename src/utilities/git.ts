/**
 * Git repository root resolution (including worktree canonicalization with
 * two-part anti-spoofing verification), bare-repo detection, remote URL
 * normalization, and subprocess status/log queries.
 */

import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { LRUCache } from 'lru-cache'
import { basename, dirname, join, resolve } from 'path'
import { registerConfigGitRootFinder } from './config.js'
import { getCwd } from './cwd.js'
import { execFileNoThrowWithCwd } from './exec_file_no_throw.js'
import { getFsImplementation } from './fs_operations.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getCommonDir,
  getWorktreeCountFromFs,
  resolveGitDir,
} from './git/git_filesystem.js'
import { whichSync } from './which.js'

const gitRootCache = new LRUCache<string, { value: string | null }>({ max: 50 })
const canonicalGitRootCache = new LRUCache<string, { value: string | null }>({
  max: 50,
})

/**
 * Memoized path to the `git` executable.
 */
export const gitExe = memoize((): string => whichSync('git') || 'git')

/**
 * Walks upward from `startDir` looking for a `.git` directory or file.
 * Returns the NFC-normalized repository root or `null`.
 */
export function findGitRoot(startDir: string = getCwd()): string | null {
  const key = resolve(startDir).normalize('NFC')
  const cached = gitRootCache.get(key)
  if (cached !== undefined) {
    return cached.value
  }

  const fsImpl = getFsImplementation()
  let current = key
  while (true) {
    if (fsImpl.existsSync(join(current, '.git'))) {
      gitRootCache.set(key, { value: current })
      return current
    }
    const parent = resolve(current, '..')
    if (parent === current) {
      gitRootCache.set(key, { value: null })
      return null
    }
    current = parent
  }
}

/**
 * Resolves the canonical main repository root for both normal repos and linked
 * git worktrees, applying two-part backlink verification against forged `.git`
 * / `commondir` files.
 */
export function findCanonicalGitRoot(
  startDir: string = getCwd(),
): string | null {
  const key = resolve(startDir).normalize('NFC')
  const cached = canonicalGitRootCache.get(key)
  if (cached !== undefined) {
    return cached.value
  }

  const gitRoot = findGitRoot(key)
  if (!gitRoot) {
    canonicalGitRootCache.set(key, { value: null })
    return null
  }

  const fsImpl = getFsImplementation()
  const dotGitPath = join(gitRoot, '.git')
  try {
    const stats = fsImpl.statSync(dotGitPath)
    if (stats.isDirectory()) {
      canonicalGitRootCache.set(key, { value: gitRoot })
      return gitRoot
    }

    const worktreeGitDir = resolveGitDir(gitRoot)
    if (!worktreeGitDir) {
      canonicalGitRootCache.set(key, { value: gitRoot })
      return gitRoot
    }

    const commonDir = getCommonDir(worktreeGitDir)
    if (commonDir === worktreeGitDir) {
      canonicalGitRootCache.set(key, { value: gitRoot })
      return gitRoot
    }

    // Two-part security check:
    // 1. Worktree gitdir must live directly under <commonDir>/worktrees/<name>
    // 2. <worktreeGitDir>/gitdir must point back to <gitRoot>/.git
    const expectedWorktreesDir = resolve(join(commonDir, 'worktrees'))
    const actualParentDir = resolve(dirname(worktreeGitDir))
    if (actualParentDir !== expectedWorktreesDir) {
      canonicalGitRootCache.set(key, { value: gitRoot })
      return gitRoot
    }

    const backlinkFile = join(worktreeGitDir, 'gitdir')
    const backlinkRaw = fsImpl
      .readFileSync(backlinkFile, { encoding: 'utf-8' })
      .trim()
    const resolvedBacklink = realpathSync(resolve(worktreeGitDir, backlinkRaw))
    const resolvedDotGit = realpathSync(dotGitPath)
    if (resolvedBacklink !== resolvedDotGit) {
      canonicalGitRootCache.set(key, { value: gitRoot })
      return gitRoot
    }

    const canonical =
      basename(commonDir) === '.git'
        ? dirname(commonDir).normalize('NFC')
        : commonDir.normalize('NFC')
    canonicalGitRootCache.set(key, { value: canonical })
    return canonical
  } catch {
    canonicalGitRootCache.set(key, { value: gitRoot })
    return gitRoot
  }
}

/**
 * Bare-repository escape defense: returns true if `dir` has no valid `.git`
 * checkout but directly contains bare-repo entries (`HEAD`, `objects/`, `refs/`).
 */
export function isCurrentDirectoryBareGitRepo(dir: string = getCwd()): boolean {
  const fsImpl = getFsImplementation()
  const dotGit = join(dir, '.git')
  try {
    if (fsImpl.existsSync(dotGit)) {
      const stats = fsImpl.statSync(dotGit)
      if (stats.isFile()) {
        return false
      }
      if (stats.isDirectory() && fsImpl.existsSync(join(dotGit, 'HEAD'))) {
        return false
      }
    }
  } catch {
    // Continue checking bare-repo markers
  }

  try {
    const hasHeadFile =
      fsImpl.existsSync(join(dir, 'HEAD')) &&
      fsImpl.statSync(join(dir, 'HEAD')).isFile()
    const hasObjectsDir =
      fsImpl.existsSync(join(dir, 'objects')) &&
      fsImpl.statSync(join(dir, 'objects')).isDirectory()
    const hasRefsDir =
      fsImpl.existsSync(join(dir, 'refs')) &&
      fsImpl.statSync(join(dir, 'refs')).isDirectory()
    return hasHeadFile || hasObjectsDir || hasRefsDir
  } catch {
    return false
  }
}

/**
 * Normalizes SSH, HTTPS, and local CCR proxy Git remote URLs to lowercase
 * `host/owner/repo`.
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!trimmed) {
    return null
  }

  // Local CCR proxy: http://127.0.0.1:PORT/git/owner/repo
  const localProxyMatch = trimmed.match(
    /^https?:\/\/127\.0\.0\.1:\d+\/git\/(.+)$/i,
  )
  if (localProxyMatch?.[1]) {
    return `github.com/${localProxyMatch[1].replace(/^\/+/, '').toLowerCase()}`
  }

  // SCP-style SSH: git@github.com:owner/repo
  const scpMatch = trimmed.match(/^(?:[^@]+@)?([^:]+):([^/].+)$/)
  if (scpMatch?.[1] && scpMatch[2] && !trimmed.includes('://')) {
    return `${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+/, '').toLowerCase()}`
  }

  try {
    const parsed = new URL(trimmed)
    const pathPart = parsed.pathname.replace(/^\/+/, '').toLowerCase()
    if (!parsed.hostname || !pathPart) {
      return null
    }
    return `${parsed.hostname.toLowerCase()}/${pathPart}`
  } catch {
    return null
  }
}

/**
 * Returns a 16-hex-char SHA-256 hash of the normalized `origin` remote URL.
 */
export async function getRepoRemoteHash(
  cwd: string = getCwd(),
): Promise<string | undefined> {
  const remoteUrl = getCachedRemoteUrl(cwd)
  if (!remoteUrl) return undefined
  const normalized = normalizeGitRemoteUrl(remoteUrl)
  if (!normalized) return undefined
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

export async function getIsGit(cwd: string = getCwd()): Promise<boolean> {
  return findGitRoot(cwd) !== null
}

export function getGitDir(cwd: string = getCwd()): string | null {
  return resolveGitDir(cwd)
}

export function isAtGitRoot(cwd: string = getCwd()): boolean {
  const root = findGitRoot(cwd)
  if (!root) return false
  try {
    return realpathSync(root) === realpathSync(cwd)
  } catch {
    return resolve(root) === resolve(cwd)
  }
}

export function dirIsInGitRepo(dir: string): boolean {
  return findGitRoot(dir) !== null
}

export async function getHead(cwd: string = getCwd()): Promise<string | null> {
  return getCachedHead(cwd)
}

export async function getBranch(cwd: string = getCwd()): Promise<string> {
  return getCachedBranch(cwd)
}

export async function getDefaultBranch(
  cwd: string = getCwd(),
): Promise<string> {
  return getCachedDefaultBranch(cwd)
}

export async function getRemoteUrl(
  cwd: string = getCwd(),
): Promise<string | null> {
  return getCachedRemoteUrl(cwd)
}

export async function getWorktreeCount(
  cwd: string = getCwd(),
): Promise<number> {
  return getWorktreeCountFromFs(cwd)
}

export async function getIsClean(cwd: string = getCwd()): Promise<boolean> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    { cwd },
  )
  return result.code === 0 && result.stdout.trim().length === 0
}

export async function getChangedFiles(
  cwd: string = getCwd(),
): Promise<string[]> {
  const result = await execFileNoThrowWithCwd(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    { cwd },
  )
  if (result.code !== 0) {
    return []
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => line.slice(3).trim())
}

/**
 * Clears cached git root lookups (for tests).
 */
export function clearGitRootCachesForTesting(): void {
  gitRootCache.clear()
  canonicalGitRootCache.clear()
}

// Wire Phase 1 config git-root finder so `getProjectPathForConfig()` groups
// worktrees and subdirectories under their canonical git root.
registerConfigGitRootFinder(dir => findCanonicalGitRoot(dir))
