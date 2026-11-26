/**
 * Zero-subprocess Git metadata reader (`.git/HEAD`, loose refs, `packed-refs`,
 * `commondir`, `.git/config`) with `fs.watchFile`-backed invalidation.
 */

import { unwatchFile, watchFile } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { waitForScrollIdle } from '../../bootstrap/state.js'
import { registerCleanup } from '../cleanup_registry.js'
import { getCwd } from '../cwd.js'
import { getFsImplementation } from '../fs_operations.js'
import { parseGitConfigValue } from './git_config_parser.js'

const SAFE_REF_REGEX = /^[a-zA-Z0-9/._+@-]+$/
const VALID_SHA_REGEX = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const MAX_SYMREF_DEPTH = 10
const WATCH_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 10 : 1000

const resolvedGitDirCache = new Map<string, string | null>()

/**
 * Validates a Git ref name against injection and path traversal sequences.
 */
export function isSafeRefName(name: string): boolean {
  if (!name || !SAFE_REF_REGEX.test(name)) {
    return false
  }
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) {
    return false
  }
  const segments = name.split('/')
  return segments.every(
    segment => segment.length > 0 && segment !== '.' && segment !== '..',
  )
}

/**
 * Validates a 40-char SHA-1 or 64-char SHA-256 lowercase Git object ID.
 */
export function isValidGitSha(sha: string): boolean {
  return VALID_SHA_REGEX.test(sha)
}

function findGitEntryUpward(startPath: string): string | null {
  const fsImpl = getFsImplementation()
  let current = resolve(startPath).normalize('NFC')
  while (true) {
    const candidate = join(current, '.git')
    if (fsImpl.existsSync(candidate)) {
      return candidate
    }
    const parent = resolve(current, '..')
    if (parent === current) {
      return null
    }
    current = parent
  }
}

/**
 * Resolves the `.git` directory for `startPath`, following worktree/submodule
 * `gitdir:` pointer files.
 */
export function resolveGitDir(startPath: string = getCwd()): string | null {
  const normalizedStart = resolve(startPath).normalize('NFC')
  if (resolvedGitDirCache.has(normalizedStart)) {
    return resolvedGitDirCache.get(normalizedStart) ?? null
  }

  const fsImpl = getFsImplementation()
  const gitEntry = findGitEntryUpward(normalizedStart)
  if (!gitEntry) {
    resolvedGitDirCache.set(normalizedStart, null)
    return null
  }

  try {
    const stats = fsImpl.statSync(gitEntry)
    if (stats.isDirectory()) {
      resolvedGitDirCache.set(normalizedStart, gitEntry)
      return gitEntry
    }
    if (stats.isFile()) {
      const content = fsImpl
        .readFileSync(gitEntry, { encoding: 'utf-8' })
        .trim()
      const match = content.match(/^gitdir:\s*(.+)$/)
      if (match?.[1]) {
        const rawTarget = match[1].trim()
        const resolvedTarget = isAbsolute(rawTarget)
          ? rawTarget
          : resolve(dirname(gitEntry), rawTarget)
        const normalizedTarget = resolvedTarget.normalize('NFC')
        resolvedGitDirCache.set(normalizedStart, normalizedTarget)
        return normalizedTarget
      }
    }
  } catch {
    // Unreadable .git entry
  }

  resolvedGitDirCache.set(normalizedStart, null)
  return null
}

/**
 * Clears the memoized `resolveGitDir` path lookup cache.
 */
export function clearResolveGitDirCache(): void {
  resolvedGitDirCache.clear()
}

/**
 * Resolves the shared `commondir` for worktrees, or returns `gitDir` itself.
 */
export function getCommonDir(gitDir: string): string {
  const fsImpl = getFsImplementation()
  const commonDirFile = join(gitDir, 'commondir')
  try {
    const raw = fsImpl
      .readFileSync(commonDirFile, { encoding: 'utf-8' })
      .trim()
    if (raw) {
      return isAbsolute(raw) ? raw : resolve(gitDir, raw)
    }
  } catch {
    // Not a linked worktree
  }
  return gitDir
}

/**
 * Reads `.git/HEAD`, returning either `{ type: 'ref', ref }` or `{ type: 'sha', sha }`.
 */
export function readGitHead(
  gitDir: string,
): { type: 'ref'; ref: string } | { type: 'sha'; sha: string } | null {
  try {
    const raw = getFsImplementation()
      .readFileSync(join(gitDir, 'HEAD'), { encoding: 'utf-8' })
      .trim()
    if (raw.startsWith('ref:')) {
      const ref = raw.slice(4).trim()
      return isSafeRefName(ref) ? { type: 'ref', ref } : null
    }
    return isValidGitSha(raw) ? { type: 'sha', sha: raw } : null
  } catch {
    return null
  }
}

function lookupPackedRef(commonDir: string, refName: string): string | null {
  try {
    const content = getFsImplementation().readFileSync(
      join(commonDir, 'packed-refs'),
      { encoding: 'utf-8' },
    )
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('^')) {
        continue
      }
      const spaceIdx = line.indexOf(' ')
      if (spaceIdx <= 0) continue
      const sha = line.slice(0, spaceIdx).trim()
      const ref = line.slice(spaceIdx + 1).trim()
      if (ref === refName && isValidGitSha(sha)) {
        return sha
      }
    }
  } catch {
    // No packed-refs file
  }
  return null
}

/**
 * Resolves a ref name (e.g. `refs/heads/main`) to its commit SHA via loose ref,
 * symbolic ref recursion, and `packed-refs`.
 */
export function resolveRef(
  gitDir: string,
  refName: string,
  depth = 0,
): string | null {
  if (depth > MAX_SYMREF_DEPTH || !isSafeRefName(refName)) {
    return null
  }
  const fsImpl = getFsImplementation()
  const commonDir = getCommonDir(gitDir)

  const candidates =
    commonDir === gitDir
      ? [join(gitDir, refName)]
      : [join(gitDir, refName), join(commonDir, refName)]

  for (const loosePath of candidates) {
    try {
      const raw = fsImpl.readFileSync(loosePath, { encoding: 'utf-8' }).trim()
      if (raw.startsWith('ref:')) {
        const target = raw.slice(4).trim()
        return resolveRef(gitDir, target, depth + 1)
      }
      if (isValidGitSha(raw)) {
        return raw
      }
    } catch {
      // Try next candidate
    }
  }

  return lookupPackedRef(commonDir, refName)
}

/**
 * Reads a symbolic ref file and strips `branchPrefix` if matched.
 */
export function readRawSymref(
  gitDir: string,
  refPath: string,
  branchPrefix: string,
): string | null {
  if (!isSafeRefName(refPath)) {
    return null
  }
  const commonDir = getCommonDir(gitDir)
  for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
    try {
      const raw = getFsImplementation()
        .readFileSync(join(base, refPath), { encoding: 'utf-8' })
        .trim()
      if (raw.startsWith('ref:')) {
        const target = raw.slice(4).trim()
        if (target.startsWith(branchPrefix)) {
          return target.slice(branchPrefix.length)
        }
      }
    } catch {
      // Absent
    }
  }
  return null
}

export function getHeadForDir(dir: string): string | null {
  const gitDir = resolveGitDir(dir)
  if (!gitDir) return null
  const head = readGitHead(gitDir)
  if (!head) return null
  if (head.type === 'sha') return head.sha
  return resolveRef(gitDir, head.ref)
}

export function readWorktreeHeadSha(worktreePath: string): string | null {
  return getHeadForDir(worktreePath)
}

export function getRemoteUrlForDir(
  dir: string,
  remoteName = 'origin',
): string | null {
  const gitDir = resolveGitDir(dir)
  if (!gitDir) return null
  const commonDir = getCommonDir(gitDir)
  try {
    const configContent = getFsImplementation().readFileSync(
      join(commonDir, 'config'),
      { encoding: 'utf-8' },
    )
    return parseGitConfigValue(configContent, 'remote', 'url', remoteName) ?? null
  } catch {
    return null
  }
}

export function isShallowClone(dir: string = getCwd()): boolean {
  const gitDir = resolveGitDir(dir)
  if (!gitDir) return false
  const commonDir = getCommonDir(gitDir)
  return getFsImplementation().existsSync(join(commonDir, 'shallow'))
}

export function getWorktreeCountFromFs(dir: string = getCwd()): number {
  const gitDir = resolveGitDir(dir)
  if (!gitDir) return 0
  const commonDir = getCommonDir(gitDir)
  const worktreesDir = join(commonDir, 'worktrees')
  try {
    const entries = getFsImplementation().readdirStringSync(worktreesDir)
    return 1 + entries.length
  } catch {
    return 1
  }
}

function computeBranchForGitDir(gitDir: string): string {
  const head = readGitHead(gitDir)
  if (!head) return ''
  if (head.type === 'ref') {
    if (head.ref.startsWith('refs/heads/')) {
      return head.ref.slice('refs/heads/'.length)
    }
    return head.ref
  }
  return 'HEAD'
}

function computeDefaultBranchForGitDir(gitDir: string): string {
  const symref = readRawSymref(
    gitDir,
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/',
  )
  if (symref) {
    return symref
  }
  if (resolveRef(gitDir, 'refs/remotes/origin/main')) {
    return 'main'
  }
  if (resolveRef(gitDir, 'refs/remotes/origin/master')) {
    return 'master'
  }
  if (resolveRef(gitDir, 'refs/heads/main')) {
    return 'main'
  }
  if (resolveRef(gitDir, 'refs/heads/master')) {
    return 'master'
  }
  return 'main'
}

interface WatchedRepoCache {
  gitDir: string
  commonDir: string
  watchedFiles: Set<string>
  branchDirty: boolean
  headDirty: boolean
  remoteDirty: boolean
  defaultBranchDirty: boolean
  branch: string
  head: string | null
  remoteUrl: string | null
  defaultBranch: string
}

class GitFileWatcher {
  private readonly caches = new Map<string, WatchedRepoCache>()
  private cleanupRegistered = false

  private ensureCleanupRegistered(): void {
    if (this.cleanupRegistered) return
    this.cleanupRegistered = true
    registerCleanup(async () => {
      this.reset()
    })
  }

  private watchPath(
    entry: WatchedRepoCache,
    filePath: string,
    onChange: () => void,
  ): void {
    if (entry.watchedFiles.has(filePath)) return
    entry.watchedFiles.add(filePath)
    watchFile(
      filePath,
      { interval: WATCH_INTERVAL_MS, persistent: false },
      () => {
        onChange()
      },
    )
  }

  private getOrCreateCache(gitDir: string): WatchedRepoCache {
    const existing = this.caches.get(gitDir)
    if (existing) {
      return existing
    }
    this.ensureCleanupRegistered()
    const commonDir = getCommonDir(gitDir)
    const entry: WatchedRepoCache = {
      gitDir,
      commonDir,
      watchedFiles: new Set(),
      branchDirty: true,
      headDirty: true,
      remoteDirty: true,
      defaultBranchDirty: true,
      branch: '',
      head: null,
      remoteUrl: null,
      defaultBranch: 'main',
    }

    const headPath = join(gitDir, 'HEAD')
    this.watchPath(entry, headPath, () => {
      entry.branchDirty = true
      entry.headDirty = true
      void waitForScrollIdle().then(() => {
        this.watchCurrentBranchRef(entry)
      })
    })
    this.watchPath(entry, join(commonDir, 'config'), () => {
      entry.remoteDirty = true
    })
    this.watchCurrentBranchRef(entry)

    this.caches.set(gitDir, entry)
    return entry
  }

  private watchCurrentBranchRef(entry: WatchedRepoCache): void {
    const head = readGitHead(entry.gitDir)
    if (head?.type === 'ref' && head.ref.startsWith('refs/heads/')) {
      const refFile = join(entry.commonDir, head.ref)
      this.watchPath(entry, refFile, () => {
        entry.headDirty = true
      })
    }
  }

  getBranch(cwd: string): string {
    const gitDir = resolveGitDir(cwd)
    if (!gitDir) return ''
    const entry = this.getOrCreateCache(gitDir)
    if (entry.branchDirty) {
      entry.branchDirty = false
      entry.branch = computeBranchForGitDir(gitDir)
    }
    return entry.branch
  }

  getHead(cwd: string): string | null {
    const gitDir = resolveGitDir(cwd)
    if (!gitDir) return null
    const entry = this.getOrCreateCache(gitDir)
    if (entry.headDirty) {
      entry.headDirty = false
      entry.head = getHeadForDir(cwd)
    }
    return entry.head
  }

  getRemoteUrl(cwd: string): string | null {
    const gitDir = resolveGitDir(cwd)
    if (!gitDir) return null
    const entry = this.getOrCreateCache(gitDir)
    if (entry.remoteDirty) {
      entry.remoteDirty = false
      entry.remoteUrl = getRemoteUrlForDir(cwd)
    }
    return entry.remoteUrl
  }

  getDefaultBranch(cwd: string): string {
    const gitDir = resolveGitDir(cwd)
    if (!gitDir) return 'main'
    const entry = this.getOrCreateCache(gitDir)
    if (entry.defaultBranchDirty) {
      entry.defaultBranchDirty = false
      entry.defaultBranch = computeDefaultBranchForGitDir(gitDir)
    }
    return entry.defaultBranch
  }

  reset(): void {
    for (const entry of this.caches.values()) {
      for (const filePath of entry.watchedFiles) {
        unwatchFile(filePath)
      }
      entry.watchedFiles.clear()
    }
    this.caches.clear()
  }
}

const gitFileWatcher = new GitFileWatcher()

export function getCachedBranch(cwd: string = getCwd()): string {
  return gitFileWatcher.getBranch(cwd)
}

export function getCachedHead(cwd: string = getCwd()): string | null {
  return gitFileWatcher.getHead(cwd)
}

export function getCachedRemoteUrl(cwd: string = getCwd()): string | null {
  return gitFileWatcher.getRemoteUrl(cwd)
}

export function getCachedDefaultBranch(cwd: string = getCwd()): string {
  return gitFileWatcher.getDefaultBranch(cwd)
}

export function resetGitFileWatcher(): void {
  gitFileWatcher.reset()
  clearResolveGitDirCache()
}
