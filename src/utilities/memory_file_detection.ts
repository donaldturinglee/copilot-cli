/**
 * Cross-platform detection of auto-managed memory files, session transcripts,
 * memory directories, and shell commands targeting memory directories.
 */

import { normalize, resolve } from 'path'
import {
  getAutoMemPath,
  getMemoryBaseDir,
  hasAutoMemPathOverride,
  isAutoMemoryEnabled,
  isAutoMemPath,
} from '../memdir/paths.js'
import { isTeamMemFile, isTeamMemPath } from '../memdir/team_mem_paths.js'
import { getClaudeConfigHomeDir } from './env_utils.js'
import { posixPathToWindowsPath } from './windows_paths.js'

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function toComparable(filePath: string): string {
  const posix = toPosix(normalize(filePath))
  return process.platform === 'win32' ? posix.toLowerCase() : posix
}

/**
 * Classifies whether `filePath` is a session memory summary or JSONL transcript
 * under the CLI config directory (`~/.copilot/`).
 */
export function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  const configDir = toComparable(getClaudeConfigHomeDir())
  const target = toComparable(resolve(filePath))
  if (!target.startsWith(`${configDir}/`) && target !== configDir) {
    return null
  }
  if (target.includes('/session-memory/') && target.endsWith('.md')) {
    return 'session_memory'
  }
  if (target.includes('/projects/') && target.endsWith('.jsonl')) {
    return 'session_transcript'
  }
  return null
}

/**
 * Detects glob/search patterns targeting session memory or session transcripts.
 */
export function detectSessionPatternType(
  pattern: string,
): 'session_memory' | 'session_transcript' | null {
  const norm = toPosix(pattern).toLowerCase()
  if (norm.includes('session-memory') && (norm.includes('.md') || norm.includes('*'))) {
    return 'session_memory'
  }
  if (norm.includes('.jsonl')) {
    return 'session_transcript'
  }
  return null
}

export function isAutoMemFile(filePath: string): boolean {
  return isAutoMemoryEnabled() && isAutoMemPath(filePath)
}

export function memoryScopeForPath(
  filePath: string,
): 'personal' | 'team' | null {
  if (isTeamMemFile(filePath)) {
    return 'team'
  }
  if (isAutoMemFile(filePath)) {
    return 'personal'
  }
  return null
}

/**
 * Returns `true` for CLI-managed memory files (auto-memory, team memory,
 * session memory/transcripts, agent memory), and `false` for user-managed
 * instruction files (`INSTRUCTIONS.md`, `INSTRUCTIONS.local.md`, `rules/*.md`).
 */
export function isAutoManagedMemoryFile(filePath: string): boolean {
  const norm = toComparable(resolve(filePath))
  if (
    norm.endsWith('/instructions.md') ||
    norm.endsWith('/instructions.local.md') ||
    norm.endsWith('/claude.md') ||
    norm.endsWith('/claude.local.md') ||
    norm.includes('/.copilot/rules/')
  ) {
    return false
  }
  if (isTeamMemFile(filePath) || isAutoMemFile(filePath)) {
    return true
  }
  if (detectSessionFileType(filePath) !== null) {
    return true
  }
  if (norm.includes('/agent-memory/') || norm.includes('/agent-memory-local/')) {
    return true
  }
  return false
}

/**
 * Returns `true` if `dirPath` is a memory or session storage directory.
 */
export function isMemoryDirectory(dirPath: string): boolean {
  const norm = toComparable(resolve(dirPath)).replace(/\/+$/, '')
  if (
    norm.includes('/agent-memory/') ||
    norm.endsWith('/agent-memory') ||
    norm.includes('/agent-memory-local/') ||
    norm.endsWith('/agent-memory-local')
  ) {
    return true
  }
  if (isTeamMemPath(dirPath) || (hasAutoMemPathOverride() && isAutoMemPath(dirPath))) {
    return true
  }

  const configBase = toComparable(getClaudeConfigHomeDir()).replace(/\/+$/, '')
  const memBase = toComparable(getMemoryBaseDir()).replace(/\/+$/, '')
  const underConfig = norm === configBase || norm.startsWith(`${configBase}/`)
  const underMem = norm === memBase || norm.startsWith(`${memBase}/`)

  if (underConfig || underMem) {
    if (
      norm.includes('/session-memory') ||
      norm.includes('/memory') ||
      (underConfig && norm.includes('/projects'))
    ) {
      return true
    }
  }
  return false
}

export function isAutoManagedMemoryPattern(pattern: string): boolean {
  if (detectSessionPatternType(pattern) !== null) {
    return true
  }
  const norm = toPosix(pattern).toLowerCase()
  return norm.includes('agent-memory/') || norm.includes('agent-memory-local/')
}

/**
 * Detects whether a shell command string references an auto-managed memory
 * file or directory (including MinGW `/c/...` paths on Windows).
 */
export function isShellCommandTargetingMemory(command: string): boolean {
  if (!command) return false
  const configDir = getClaudeConfigHomeDir()
  const memBase = getMemoryBaseDir()
  const autoMemDir = getAutoMemPath()

  const probes = [configDir, memBase, autoMemDir]
    .map(p => toComparable(p).replace(/\/+$/, ''))
    .filter(Boolean)

  const cmdLower = toPosix(command).toLowerCase()
  const maybeMentions = probes.some(p => {
    if (cmdLower.includes(p)) return true
    // MinGW /c/Users/... variant on Windows
    const driveMatch = p.match(/^([a-z]):\/(.*)$/)
    if (driveMatch) {
      return cmdLower.includes(`/${driveMatch[1]}/${driveMatch[2]}`)
    }
    return false
  })
  if (!maybeMentions && !cmdLower.includes('agent-memory')) {
    return false
  }

  const tokenRegex = /(?:[A-Za-z]:[/\\]|\/)[^\s'"]+/g
  let match = tokenRegex.exec(command)
  while (match !== null) {
    let candidate = match[0]!
    if (process.platform === 'win32' && /^\/[a-z]\//i.test(candidate)) {
      try {
        candidate = posixPathToWindowsPath(candidate)
      } catch {
        // Keep original token
      }
    }
    if (isAutoManagedMemoryFile(candidate) || isMemoryDirectory(candidate)) {
      return true
    }
    match = tokenRegex.exec(command)
  }
  return false
}
