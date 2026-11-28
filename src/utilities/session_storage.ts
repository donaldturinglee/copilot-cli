/**
 * JSONL Session Persistence & DAG Restoration Engine (`src/utilities/session_storage.ts`):
 * - Lazy file creation (`sessionFile: string | null`, `pendingEntries`) until first
 *   user/assistant message (`materializeSessionFile`)
 * - 100ms batched per-file write queue (`0o700` dir / `0o600` file modes, 100MB chunk cap)
 * - Tail metadata re-appending (`reAppendSessionMetadata`) with external-writer tail refresh
 * - In-place 64KB tail-splice tombstone cleanup (`removeMessageByUuid`) + 50MB slow-path guard
 * - >5MB transcript loading: pre-compact skip (`readTranscriptForLoad`), pre-boundary metadata
 *   scan (`scanPreBoundaryMetadata`), and byte-level dead-branch trimming (`walkChainBeforeParse`)
 * - DAG restoration (`buildConversationChain`) with O(n) parallel `tool_result` & sibling
 *   assistant recovery (`recoverOrphanedParallelToolResults`)
 */

import type { UUID } from 'crypto'
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
} from 'fs'
import {
  appendFile as fsAppendFile,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
} from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  ContentReplacementRecord,
  FileHistorySnapshot,
} from '../types/forward.js'
import type { AgentId } from '../types/ids.js'
import {
  type AttributionSnapshotMessage,
  type ContextCollapseCommitEntry,
  type ContextCollapseSnapshotEntry,
  type Entry,
  type FileHistorySnapshotMessage,
  type LogOption,
  type PersistedWorktreeSession,
  type SerializedMessage,
  sortLogs,
  type TranscriptMessage,
} from '../types/logs.js'
import type { AssistantMessage, Message, UserMessage } from '../types/message.js'
import { registerCleanup } from './cleanup_registry.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './env_utils.js'
import { getActiveRepoWorktreePaths } from './get_worktree_paths.js'
import { parseJsonl } from './json.js'
import { logError } from './log.js'
import { isCompactBoundaryMessage } from './messages.js'
import { MAX_SANITIZED_LENGTH, sanitizePath } from './path.js'
import {
  extractFirstPromptFromHead,
  extractJsonStringField,
  extractJsonStringFieldPrefix,
  extractLastJsonStringField,
  getProjectsDirPortable,
  LITE_READ_BUF_SIZE,
  readFileTailSync,
  readHeadAndTail,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from './session_storage_portable.js'
import { getInitialSettings } from './settings/settings.js'
import { jsonParse, jsonStringify } from './slow_operations.js'
import { validateUuid } from './uuid.js'

export const FLUSH_INTERVAL_MS = 100
export const REMOTE_FLUSH_INTERVAL_MS = 10
export const MAX_CHUNK_BYTES = 100 * 1024 * 1024
export const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024
export const INITIAL_ENRICH_COUNT = 50

const PARENT_PREFIX = Buffer.from('{"parentUuid":')
const UUID_KEY = Buffer.from('"uuid":"')
const TS_SUFFIX = Buffer.from('","timestamp":"')
const SIDECHAIN_TRUE_COMPACT = Buffer.from('"isSidechain":true')
const SIDECHAIN_TRUE_SPACED = Buffer.from('"isSidechain": true')
const METADATA_PREFIX_BOUND = 25
const MAX_METADATA_CARRY_BYTES = 64 * 1024

const METADATA_TYPE_MARKERS: readonly Buffer[] = [
  Buffer.from('"type":"summary"'),
  Buffer.from('"type":"custom-title"'),
  Buffer.from('"type":"tag"'),
  Buffer.from('"type":"agent-name"'),
  Buffer.from('"type":"agent-color"'),
  Buffer.from('"type":"agent-setting"'),
  Buffer.from('"type":"mode"'),
  Buffer.from('"type":"worktree-state"'),
  Buffer.from('"type":"pr-link"'),
]

const TRANSCRIPT_MESSAGE_TYPES = new Set([
  'user',
  'assistant',
  'attachment',
  'system',
])

const NON_MESSAGE_ENTRY_TYPES = new Set([
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'task-summary',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'file-history-snapshot',
  'attribution-snapshot',
  'speculation-accept',
  'mode',
  'worktree-state',
  'marble-origami-commit',
  'marble-origami-snapshot',
  'queue-operation',
  'content-replacement',
])

export interface SessionCandidate {
  sessionId: UUID
  fullPath: string
  mtime: number
  ctime: number
  size: number
}

export interface LoadedTranscriptData {
  messages: Map<UUID, TranscriptMessage>
  leafUuids: Set<UUID>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  aiTitles: Map<UUID, string>
  lastPrompts: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  modes: Map<UUID, 'coordinator' | 'normal'>
  worktreeSessions: Map<UUID, PersistedWorktreeSession | null>
  prLinks: Map<UUID, { prNumber: number; prUrl: string; prRepository: string }>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: AttributionSnapshotMessage[]
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  contentReplacements: ContentReplacementRecord[]
  contentReplacementsByAgent: Map<string, ContentReplacementRecord[]>
}

export interface SessionMetadataSnapshot {
  customTitle?: string
  tag?: string
  lastPrompt?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

export function getProjectsDir(): string {
  return getProjectsDirPortable()
}

export const getProjectDir = memoize((projectDir: string): string =>
  join(getProjectsDir(), sanitizePath(projectDir)),
)

export function clearProjectDirCache(): void {
  getProjectDir.cache.clear?.()
}

function getEffectiveProjectDir(): string {
  return getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
}

/**
 * Returns the active session's JSONL transcript path
 * (`~/.copilot/projects/<sanitized-project>/<sessionId>.jsonl`).
 */
export function getTranscriptPath(): string {
  return join(getEffectiveProjectDir(), `${getSessionId()}.jsonl`)
}

/**
 * Returns the JSONL transcript path for a specific session ID.
 */
export function getTranscriptPathForSession(
  sessionId: string,
  projectDir?: string,
): string {
  if (projectDir) {
    return join(getProjectDir(projectDir), `${sessionId}.jsonl`)
  }
  const baseDir =
    sessionId === getSessionId()
      ? getEffectiveProjectDir()
      : getProjectDir(getOriginalCwd())
  return join(baseDir, `${sessionId}.jsonl`)
}

const agentTranscriptSubdirs = new Map<string, string>()

export function setAgentTranscriptSubdir(agentId: string, subdir: string): void {
  agentTranscriptSubdirs.set(agentId, subdir)
}

/**
 * Returns the subagent transcript JSONL path:
 * `<projectDir>/<sessionId>/subagents/[<subdir>/]agent-<agentId>.jsonl`.
 */
export function getAgentTranscriptPath(
  agentId: AgentId | string,
  sessionId: string = getSessionId(),
): string {
  const subdir = agentTranscriptSubdirs.get(String(agentId))
  const base = join(getEffectiveProjectDir(), sessionId, 'subagents')
  return subdir
    ? join(base, subdir, `agent-${agentId}.jsonl`)
    : join(base, `agent-${agentId}.jsonl`)
}

export function getRemoteAgentsDir(
  sessionId: string = getSessionId(),
): string {
  return join(getEffectiveProjectDir(), sessionId, 'remote-agents')
}

export function shouldSkipPersistence(): boolean {
  if (
    process.env.NODE_ENV === 'test' &&
    !isEnvTruthy(process.env.TEST_ENABLE_SESSION_PERSISTENCE)
  ) {
    return true
  }
  if (getInitialSettings().cleanupPeriodDays === 0) {
    return true
  }
  if (isSessionPersistenceDisabled()) {
    return true
  }
  if (isEnvTruthy(process.env.COPILOT_CLI_SKIP_PROMPT_HISTORY)) {
    return true
  }
  return false
}

export function isTranscriptMessage(entry: unknown): entry is TranscriptMessage {
  if (!entry || typeof entry !== 'object') return false
  const rec = entry as { type?: unknown; uuid?: unknown }
  return (
    typeof rec.type === 'string' &&
    TRANSCRIPT_MESSAGE_TYPES.has(rec.type) &&
    typeof rec.uuid === 'string'
  )
}

export function isChainParticipant(message: Message): boolean {
  return message.type !== 'progress'
}

function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

async function appendToFile(filePath: string, data: string): Promise<void> {
  try {
    await fsAppendFile(filePath, data, { encoding: 'utf8', mode: 0o600 })
  } catch {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await fsAppendFile(filePath, data, { encoding: 'utf8', mode: 0o600 })
  }
}

function appendEntryToFileSync(filePath: string, entry: Entry): void {
  const line = `${jsonStringify(entry)}\n`
  try {
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 })
  } catch {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 })
  }
}

function extractCompactLastPrompt(message: UserMessage): string | undefined {
  if (message.isMeta || message.isCompactSummary) {
    return undefined
  }
  const content = message.message.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    if (content.some(b => b.type === 'tool_result')) {
      return undefined
    }
    text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
  }
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (!flattened) return undefined
  return flattened.length > 200
    ? `${flattened.slice(0, 200)}\u2026`
    : flattened
}

type QueuedWriteItem = {
  entry: Entry
  resolve: () => void
}

type RemoteEventWriter = (
  sessionId: string,
  entry: Entry,
  meta?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

class ProjectSessionStore {
  sessionFile: string | null = null
  private pendingEntries: Entry[] = []
  private readonly writeQueues = new Map<string, QueuedWriteItem[]>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private pendingWriteCount = 0
  private flushResolvers: Array<() => void> = []
  private readonly sessionMessageSets = new Map<string, Set<UUID>>()
  private remoteEventWriter: RemoteEventWriter | null = null
  private flushIntervalMs = FLUSH_INTERVAL_MS

  // Cached startup / tail metadata
  currentSessionTitle: string | undefined
  currentSessionTag: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPr:
    | { prNumber: number; prUrl: string; prRepository: string }
    | undefined

  setRemoteEventWriter(writer: RemoteEventWriter | null): void {
    this.remoteEventWriter = writer
    this.flushIntervalMs = writer
      ? REMOTE_FLUSH_INTERVAL_MS
      : FLUSH_INTERVAL_MS
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.pendingWriteCount++
    try {
      return await fn()
    } finally {
      this.pendingWriteCount--
      if (this.pendingWriteCount === 0 && this.flushResolvers.length > 0) {
        const resolvers = this.flushResolvers.splice(0)
        for (const resolve of resolvers) {
          resolve()
        }
      }
    }
  }

  getSessionMessageSet(sessionId: string): Set<UUID> {
    let set = this.sessionMessageSets.get(sessionId)
    if (!set) {
      set = new Set<UUID>()
      this.sessionMessageSets.set(sessionId, set)
    }
    return set
  }

  primeSessionMessageSet(sessionId: string, uuids: Iterable<UUID>): void {
    const set = this.getSessionMessageSet(sessionId)
    for (const id of uuids) {
      set.add(id)
    }
  }

  clearSessionMessagesCache(): void {
    this.sessionMessageSets.clear()
  }

  resetSessionFilePointer(): void {
    this.sessionFile = null
    this.pendingEntries = []
  }

  resetAllMetadataForTests(): void {
    this.sessionFile = null
    this.pendingEntries = []
    this.sessionMessageSets.clear()
    this.currentSessionTitle = undefined
    this.currentSessionTag = undefined
    this.currentSessionLastPrompt = undefined
    this.currentSessionAgentName = undefined
    this.currentSessionAgentColor = undefined
    this.currentSessionAgentSetting = undefined
    this.currentSessionMode = undefined
    this.currentSessionWorktree = undefined
    this.currentSessionPr = undefined
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      queue.push({ entry, resolve })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.flushTimer !== null || this.activeDrain !== null) {
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.activeDrain = this.drainWriteQueue()
        .catch(err => logError(err))
        .finally(() => {
          this.activeDrain = null
          if (this.writeQueues.size > 0) {
            this.scheduleDrain()
          }
        })
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  private async drainWriteQueue(): Promise<void> {
    const filePaths = Array.from(this.writeQueues.keys())
    for (const filePath of filePaths) {
      const queue = this.writeQueues.get(filePath)
      if (!queue || queue.length === 0) {
        this.writeQueues.delete(filePath)
        continue
      }
      const batch = queue.splice(0, queue.length)
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }

      let chunk = ''
      let chunkResolvers: Array<() => void> = []

      for (const item of batch) {
        const line = `${jsonStringify(item.entry)}\n`
        if (chunk.length > 0 && chunk.length + line.length >= MAX_CHUNK_BYTES) {
          await appendToFile(filePath, chunk)
          for (const resolve of chunkResolvers) {
            resolve()
          }
          chunk = ''
          chunkResolvers = []
        }
        chunk += line
        chunkResolvers.push(item.resolve)
      }

      if (chunk.length > 0) {
        await appendToFile(filePath, chunk)
        for (const resolve of chunkResolvers) {
          resolve()
        }
      }
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.activeDrain !== null) {
      await this.activeDrain
    }
    if (this.writeQueues.size > 0) {
      await this.drainWriteQueue()
    }
    if (this.pendingWriteCount > 0) {
      await new Promise<void>(resolve => {
        this.flushResolvers.push(resolve)
      })
    }
  }

  private async materializeSessionFile(): Promise<void> {
    if (this.sessionFile !== null || shouldSkipPersistence()) {
      return
    }
    this.sessionFile = getTranscriptPath()
    this.reAppendSessionMetadata()
    const buffered = this.pendingEntries.splice(0)
    for (const entry of buffered) {
      await this.appendEntry(entry)
    }
  }

  adoptResumedSessionFile(): void {
    if (shouldSkipPersistence()) {
      return
    }
    this.sessionFile = getTranscriptPath()
    this.reAppendSessionMetadata(true)
  }

  async appendEntry(entry: Entry): Promise<void> {
    if (shouldSkipPersistence()) {
      return
    }

    if (entry.type === 'content-replacement') {
      const target = entry.agentId
        ? getAgentTranscriptPath(entry.agentId)
        : this.sessionFile
      if (!target) {
        this.pendingEntries.push(entry)
        return
      }
      await this.enqueueWrite(target, entry)
      return
    }

    if (NON_MESSAGE_ENTRY_TYPES.has(entry.type)) {
      if (!this.sessionFile) {
        this.pendingEntries.push(entry)
        return
      }
      await this.enqueueWrite(this.sessionFile, entry)
      return
    }

    if (isTranscriptMessage(entry)) {
      const isAgentSidechain =
        entry.isSidechain && entry.agentId !== undefined
      const sessionId = entry.sessionId || getSessionId()

      if (isAgentSidechain) {
        const agentFile = getAgentTranscriptPath(entry.agentId!, sessionId)
        await this.enqueueWrite(agentFile, entry)
        return
      }

      if (!this.sessionFile) {
        this.pendingEntries.push(entry)
        return
      }

      const messageSet = this.getSessionMessageSet(sessionId)
      if (!messageSet.has(entry.uuid)) {
        messageSet.add(entry.uuid)
        await this.enqueueWrite(this.sessionFile, entry)
        if (this.remoteEventWriter) {
          try {
            await this.remoteEventWriter(sessionId, entry, {
              isCompaction: isCompactBoundaryMessage(entry) ? true : undefined,
            })
          } catch (err) {
            logEvent('tengu_session_persistence_failed', {})
            logForDebugging(`Remote transcript write failed: ${String(err)}`)
          }
        }
      }
    }
  }

  async insertMessageChain(
    messages: readonly Message[],
    options?: {
      isSidechain?: boolean
      agentId?: string
      parentUuidHint?: UUID | null
      gitBranch?: string
      slug?: string
      teamName?: string
      agentName?: string
      agentColor?: string
      promptId?: string
    },
  ): Promise<UUID | null> {
    if (shouldSkipPersistence()) {
      return null
    }
    return this.trackWrite(async () => {
      const hasConversationMsg = messages.some(
        m => m.type === 'user' || m.type === 'assistant',
      )
      if (
        !options?.isSidechain &&
        this.sessionFile === null &&
        hasConversationMsg
      ) {
        await this.materializeSessionFile()
      }

      const sessionId = getSessionId()
      const cwd = getOriginalCwd()
      const version = getMacroVersion()
      const userType = process.env.USER_TYPE ?? 'external'
      const entrypoint = process.env.COPILOT_CLI_ENTRYPOINT
      let previousParentUuid: UUID | null = options?.parentUuidHint ?? null

      for (const msg of messages) {
        if (!isChainParticipant(msg)) {
          continue
        }

        if (msg.type === 'user' && !options?.isSidechain) {
          const promptSummary = extractCompactLastPrompt(msg)
          if (promptSummary) {
            this.currentSessionLastPrompt = promptSummary
          }
        }

        const isBoundary = isCompactBoundaryMessage(msg)
        const parentUuid: UUID | null = isBoundary ? null : previousParentUuid
        const logicalParentUuid: UUID | undefined = isBoundary
          ? (msg.logicalParentUuid ?? previousParentUuid ?? undefined)
          : undefined

        // Stamp session metadata AFTER `...msg` so `--fork-session` never retains source sessionId
        const transcriptEntry: TranscriptMessage = {
          ...(msg as Message),
          parentUuid,
          ...(logicalParentUuid !== undefined ? { logicalParentUuid } : {}),
          isSidechain: Boolean(options?.isSidechain),
          userType,
          ...(entrypoint ? { entrypoint } : {}),
          cwd,
          sessionId,
          version,
          ...(options?.gitBranch ? { gitBranch: options.gitBranch } : {}),
          ...(options?.slug ? { slug: options.slug } : {}),
          ...(options?.agentId ? { agentId: options.agentId } : {}),
          ...(options?.teamName ? { teamName: options.teamName } : {}),
          ...(options?.agentName ? { agentName: options.agentName } : {}),
          ...(options?.agentColor ? { agentColor: options.agentColor } : {}),
          ...(options?.promptId ? { promptId: options.promptId } : {}),
        }

        await this.appendEntry(transcriptEntry)
        previousParentUuid = msg.uuid
      }

      return previousParentUuid
    })
  }

  /**
   * Re-appends cached session metadata at the tail of the JSONL file so 64KB
   * lite readers always find the latest title, tag, mode, worktree, and PR link.
   * Refreshes `customTitle` and `tag` from external writers first.
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    const sessionId = getSessionId()
    if (!this.sessionFile || !sessionId || shouldSkipPersistence()) {
      return
    }

    const tail = readFileTailSync(this.sessionFile)
    if (tail) {
      const lines = tail.split('\n')
      if (!skipTitleRefresh) {
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]!
          if (line.startsWith('{"type":"custom-title"')) {
            const tailTitle = extractLastJsonStringField(line, 'customTitle')
            if (tailTitle !== undefined) {
              this.currentSessionTitle = tailTitle || undefined
            }
            break
          }
        }
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (line.startsWith('{"type":"tag"')) {
          const tailTag = extractLastJsonStringField(line, 'tag')
          if (tailTag !== undefined) {
            this.currentSessionTag = tailTag || undefined
          }
          break
        }
      }
    }

    const sid = sessionId as UUID
    // Append less critical first so most critical metadata sits closest to EOF
    if (this.currentSessionLastPrompt) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'last-prompt',
        sessionId: sid,
        lastPrompt: this.currentSessionLastPrompt,
      })
    }
    if (this.currentSessionTitle) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'custom-title',
        sessionId: sid,
        customTitle: this.currentSessionTitle,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'tag',
        sessionId: sid,
        tag: this.currentSessionTag,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'agent-name',
        sessionId: sid,
        agentName: this.currentSessionAgentName,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'agent-color',
        sessionId: sid,
        agentColor: this.currentSessionAgentColor,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'agent-setting',
        sessionId: sid,
        agentSetting: this.currentSessionAgentSetting,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'mode',
        sessionId: sid,
        mode: this.currentSessionMode,
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'worktree-state',
        sessionId: sid,
        worktreeSession: this.currentSessionWorktree,
      })
    }
    if (this.currentSessionPr) {
      appendEntryToFileSync(this.sessionFile, {
        type: 'pr-link',
        sessionId: sid,
        prNumber: this.currentSessionPr.prNumber,
        prUrl: this.currentSessionPr.prUrl,
        prRepository: this.currentSessionPr.prRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  /**
   * In-place tombstone removal of a single message line matching `targetUuid`:
   * - Fast path: scans last 64KB, locates line boundaries, and calls `truncate`
   *   + tail splice write (O(1) single `ftruncate` when removing the last entry).
   * - Slow path: rewrites file if <= 50MB; skips with warning above 50MB.
   */
  async removeMessageByUuid(
    targetUuid: UUID,
    explicitFilePath?: string,
  ): Promise<boolean> {
    const targetFile = explicitFilePath ?? this.sessionFile
    if (!targetFile) {
      return false
    }
    return this.trackWrite(async () => {
      await this.flushQueuesOnly()
      const needle = Buffer.from(`"uuid":"${targetUuid}"`, 'utf8')
      let fh: Awaited<ReturnType<typeof open>> | undefined
      try {
        fh = await open(targetFile, 'r+')
        const st = await fh.stat()
        if (st.size === 0) {
          return false
        }

        const chunkLen = Math.min(st.size, LITE_READ_BUF_SIZE)
        const tailStart = st.size - chunkLen
        const tail = Buffer.allocUnsafe(chunkLen)
        const { bytesRead } = await fh.read(tail, 0, chunkLen, tailStart)
        const matchIdx = tail.subarray(0, bytesRead).lastIndexOf(needle)

        if (matchIdx !== -1) {
          const prevNl = tail.subarray(0, matchIdx).lastIndexOf(0x0a)
          if (prevNl >= 0 || tailStart === 0) {
            const lineStart = prevNl + 1
            const nextNl = tail
              .subarray(0, bytesRead)
              .indexOf(0x0a, matchIdx + needle.length)
            const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead
            const absLineStart = tailStart + lineStart
            const afterLen = bytesRead - lineEnd

            await fh.truncate(absLineStart)
            if (afterLen > 0) {
              await fh.write(tail, lineEnd, afterLen, absLineStart)
            }
            const set = this.sessionMessageSets.get(getSessionId())
            set?.delete(targetUuid)
            return true
          }
        }

        // Slow path: line not completely within last 64KB
        await fh.close()
        fh = undefined

        if (st.size > MAX_TOMBSTONE_REWRITE_BYTES) {
          logForDebugging(
            `Skipping tombstone rewrite for ${targetUuid}: file size ${st.size} exceeds 50MB guard`,
            { level: 'warn' },
          )
          return false
        }

        const raw = await readFile(targetFile, 'utf8')
        const lines = raw.split('\n')
        let removed = false
        const kept: string[] = []
        for (const line of lines) {
          if (!line.trim()) {
            kept.push(line)
            continue
          }
          try {
            const parsed = jsonParse(line) as { uuid?: unknown }
            if (parsed.uuid === targetUuid) {
              removed = true
              continue
            }
          } catch {
            // Preserve malformed lines verbatim
          }
          kept.push(line)
        }

        if (removed) {
          await writeFile(targetFile, kept.join('\n'), {
            encoding: 'utf8',
            mode: 0o600,
          })
          const set = this.sessionMessageSets.get(getSessionId())
          set?.delete(targetUuid)
        }
        return removed
      } catch {
        return false
      } finally {
        if (fh) {
          await fh.close().catch(() => {})
        }
      }
    })
  }

  private async flushQueuesOnly(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.activeDrain !== null) {
      await this.activeDrain
    }
    if (this.writeQueues.size > 0) {
      await this.drainWriteQueue()
    }
  }
}

let projectInstance: ProjectSessionStore | null = null
let cleanupRegistered = false

function getProject(): ProjectSessionStore {
  if (!projectInstance) {
    projectInstance = new ProjectSessionStore()
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      await projectInstance?.flush()
      try {
        projectInstance?.reAppendSessionMetadata()
      } catch {
        // Best-effort exit metadata stamp
      }
    })
  }
  return projectInstance
}

// =============================================================================
// Public Write & Metadata Helpers
// =============================================================================

export async function recordTranscript(
  messages: readonly Message[],
  options?: Parameters<ProjectSessionStore['insertMessageChain']>[1],
): Promise<UUID | null> {
  return getProject().insertMessageChain(messages, options)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
): Promise<void> {
  await getProject().appendEntry({
    type: 'file-history-snapshot',
    messageId,
    snapshot,
    isSnapshotUpdate,
  })
}

export async function recordContentReplacement(
  replacements: readonly ContentReplacementRecord[],
  agentId?: AgentId,
): Promise<void> {
  if (replacements.length === 0) return
  await getProject().appendEntry({
    type: 'content-replacement',
    sessionId: getSessionId() as UUID,
    ...(agentId ? { agentId } : {}),
    replacements: [...replacements],
  })
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
): Promise<void> {
  await getProject().appendEntry(snapshot)
}

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
): Promise<void> {
  const project = getProject()
  project.currentSessionTitle = customTitle || undefined
  await project.appendEntry({
    type: 'custom-title',
    sessionId,
    customTitle,
  })
}

export function cacheSessionTitle(title: string | undefined): void {
  getProject().currentSessionTitle = title
}

export async function saveTag(sessionId: UUID, tag: string): Promise<void> {
  const project = getProject()
  project.currentSessionTag = tag || undefined
  await project.appendEntry({
    type: 'tag',
    sessionId,
    tag,
  })
}

export async function saveSummary(
  leafUuid: UUID,
  summary: string,
): Promise<void> {
  await getProject().appendEntry({
    type: 'summary',
    leafUuid,
    summary,
  })
}

export async function saveMode(
  mode: 'coordinator' | 'normal',
  sessionId: UUID = getSessionId() as UUID,
): Promise<void> {
  const project = getProject()
  project.currentSessionMode = mode
  if (project.sessionFile !== null) {
    await project.appendEntry({ type: 'mode', sessionId, mode })
  }
}

export async function saveAgentSetting(
  agentSetting: string,
  sessionId: UUID = getSessionId() as UUID,
): Promise<void> {
  const project = getProject()
  project.currentSessionAgentSetting = agentSetting
  if (project.sessionFile !== null) {
    await project.appendEntry({ type: 'agent-setting', sessionId, agentSetting })
  }
}

export async function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
  sessionId: UUID = getSessionId() as UUID,
): Promise<void> {
  const project = getProject()
  project.currentSessionWorktree = worktreeSession
  if (project.sessionFile !== null) {
    await project.appendEntry({
      type: 'worktree-state',
      sessionId,
      worktreeSession,
    })
  }
}

export async function savePrLink(
  prNumber: number,
  prUrl: string,
  prRepository: string,
  sessionId: UUID = getSessionId() as UUID,
): Promise<void> {
  const project = getProject()
  project.currentSessionPr = { prNumber, prUrl, prRepository }
  await project.appendEntry({
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
}

export function restoreSessionMetadata(meta: SessionMetadataSnapshot): void {
  const project = getProject()
  // Preserve explicit CLI `--name` override via `??=`
  project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag
  if (meta.lastPrompt !== undefined) {
    project.currentSessionLastPrompt = meta.lastPrompt
  }
  if (meta.agentName !== undefined) {
    project.currentSessionAgentName = meta.agentName
  }
  if (meta.agentColor !== undefined) {
    project.currentSessionAgentColor = meta.agentColor
  }
  if (meta.agentSetting !== undefined) {
    project.currentSessionAgentSetting = meta.agentSetting
  }
  if (meta.mode !== undefined) project.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined) {
    project.currentSessionWorktree = meta.worktreeSession
  }
  if (
    meta.prNumber !== undefined &&
    meta.prUrl !== undefined &&
    meta.prRepository !== undefined
  ) {
    project.currentSessionPr = {
      prNumber: meta.prNumber,
      prUrl: meta.prUrl,
      prRepository: meta.prRepository,
    }
  }
}

export function reAppendSessionMetadata(skipTitleRefresh = false): void {
  getProject().reAppendSessionMetadata(skipTitleRefresh)
}

export function resetSessionFilePointer(): void {
  getProject().resetSessionFilePointer()
}

export function adoptResumedSessionFile(): void {
  getProject().adoptResumedSessionFile()
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

export function clearSessionMessagesCache(): void {
  getProject().clearSessionMessagesCache()
}

export function setRemoteEventWriter(writer: RemoteEventWriter | null): void {
  getProject().setRemoteEventWriter(writer)
}

export async function removeMessageByUuid(
  targetUuid: UUID,
  explicitFilePath?: string,
): Promise<boolean> {
  return getProject().removeMessageByUuid(targetUuid, explicitFilePath)
}

export function resetSessionStorageForTests(): void {
  getProject().resetAllMetadataForTests()
  clearProjectDirCache()
  agentTranscriptSubdirs.clear()
}

// =============================================================================
// Large-File Optimization: Pre-Boundary Metadata & Byte-Level Dead-Branch Trim
// =============================================================================

async function scanPreBoundaryMetadata(
  filePath: string,
  endOffset: number,
): Promise<Entry[]> {
  if (endOffset <= 0) {
    return []
  }

  const matchedLines: Buffer[] = []
  let carry: Buffer = Buffer.alloc(0)

  const lineHasMetadataMarker = (line: Buffer): boolean => {
    if (line.length === 0 || line[0] !== 0x7b) {
      return false
    }
    const prefixEnd = Math.min(line.length, 64)
    const prefix = line.subarray(0, prefixEnd)
    for (const marker of METADATA_TYPE_MARKERS) {
      if (prefix.includes(marker)) {
        return true
      }
    }
    return false
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath, {
      start: 0,
      end: endOffset - 1,
      highWaterMark: 256 * 1024,
    })

    stream.on('data', (rawChunk: Buffer | string) => {
      const chunk =
        typeof rawChunk === 'string' ? Buffer.from(rawChunk, 'utf8') : rawChunk

      // Fast skip: if carry cannot be metadata and chunk has no metadata markers
      let chunkHasMarker = false
      for (const marker of METADATA_TYPE_MARKERS) {
        if (chunk.includes(marker)) {
          chunkHasMarker = true
          break
        }
      }

      if (!chunkHasMarker && carry.length === 0) {
        const lastNl = chunk.lastIndexOf(0x0a)
        const trailing = lastNl >= 0 ? chunk.subarray(lastNl + 1) : chunk
        carry =
          trailing.length <= MAX_METADATA_CARRY_BYTES
            ? Buffer.from(trailing)
            : Buffer.alloc(0)
        return
      }

      let cursor = 0
      if (carry.length > 0) {
        if (
          carry.length >= METADATA_PREFIX_BOUND &&
          !lineHasMetadataMarker(carry)
        ) {
          const nlIdx = chunk.indexOf(0x0a)
          if (nlIdx === -1) {
            return
          }
          carry = Buffer.alloc(0)
          cursor = nlIdx + 1
        } else {
          const nlIdx = chunk.indexOf(0x0a)
          if (nlIdx !== -1) {
            const fullLine = Buffer.concat([carry, chunk.subarray(0, nlIdx)])
            if (lineHasMetadataMarker(fullLine)) {
              matchedLines.push(fullLine)
            }
            carry = Buffer.alloc(0)
            cursor = nlIdx + 1
          } else {
            carry =
              carry.length + chunk.length <= MAX_METADATA_CARRY_BYTES
                ? Buffer.concat([carry, chunk])
                : Buffer.alloc(0)
            return
          }
        }
      }

      while (cursor < chunk.length) {
        const nlIdx = chunk.indexOf(0x0a, cursor)
        if (nlIdx === -1) {
          const tailSlice = chunk.subarray(cursor)
          carry =
            tailSlice.length <= MAX_METADATA_CARRY_BYTES
              ? Buffer.from(tailSlice)
              : Buffer.alloc(0)
          break
        }
        const line = chunk.subarray(cursor, nlIdx)
        if (lineHasMetadataMarker(line)) {
          matchedLines.push(Buffer.from(line))
        }
        cursor = nlIdx + 1
      }
    })

    stream.on('end', () => {
      if (carry.length > 0 && lineHasMetadataMarker(carry)) {
        matchedLines.push(carry)
      }
      resolvePromise()
    })
    stream.on('error', rejectPromise)
  })

  if (matchedLines.length === 0) {
    return []
  }
  const combined = Buffer.concat(
    matchedLines.flatMap(l => [l, Buffer.from('\n')]),
  )
  return parseJsonl<Entry>(combined)
}

function pickDepthOneUuidCandidate(
  buf: Buffer,
  lineStart: number,
  lineEnd: number,
  candidates: readonly number[],
): number {
  let depth = 0
  let inString = false
  let escaped = false
  let candidateIdx = 0

  for (let pos = lineStart; pos < lineEnd && candidateIdx < candidates.length; pos++) {
    while (
      candidateIdx < candidates.length &&
      pos >= candidates[candidateIdx]!
    ) {
      if (depth === 1 && !inString) {
        return candidates[candidateIdx]!
      }
      candidateIdx++
    }
    const byte = buf[pos]!
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (byte === 0x5c) {
        escaped = true
      } else if (byte === 0x22) {
        inString = false
      }
      continue
    }
    if (byte === 0x22) {
      inString = true
    } else if (byte === 0x7b) {
      depth++
    } else if (byte === 0x7d) {
      depth--
    }
  }

  return candidates[candidates.length - 1]!
}

function extractTopLevelUuidFromLine(
  buf: Buffer,
  lineStart: number,
  lineEnd: number,
): string | null {
  const suffixMatches: number[] = []
  let firstAny = -1
  let searchPos = lineStart

  while (searchPos < lineEnd) {
    const keyIdx = buf.indexOf(UUID_KEY, searchPos)
    if (keyIdx === -1 || keyIdx >= lineEnd) break
    const uuidStart = keyIdx + UUID_KEY.length
    const uuidEnd = uuidStart + 36
    if (uuidEnd <= lineEnd) {
      if (firstAny === -1) {
        firstAny = uuidStart
      }
      if (
        uuidEnd + TS_SUFFIX.length <= lineEnd &&
        buf.compare(
          TS_SUFFIX,
          0,
          TS_SUFFIX.length,
          uuidEnd,
          uuidEnd + TS_SUFFIX.length,
        ) === 0
      ) {
        suffixMatches.push(keyIdx)
      }
    }
    searchPos = uuidStart
  }

  if (suffixMatches.length === 1) {
    const start = suffixMatches[0]! + UUID_KEY.length
    return buf.toString('latin1', start, start + 36)
  }
  if (suffixMatches.length >= 2) {
    const chosenKey = pickDepthOneUuidCandidate(
      buf,
      lineStart,
      lineEnd,
      suffixMatches,
    )
    const start = chosenKey + UUID_KEY.length
    return buf.toString('latin1', start, start + 36)
  }
  if (firstAny !== -1) {
    return buf.toString('latin1', firstAny, firstAny + 36)
  }
  return null
}

/**
 * Byte-level dead-branch trimmer for >5MB transcripts:
 * Walks `parentUuid` chains directly on the raw Buffer before JSON.parse,
 * excising abandoned/rewound branches when savings are >= 50% of bytes.
 */
export function walkChainBeforeParse(buf: Buffer): Buffer {
  const len = buf.length
  if (len === 0) return buf

  // Stride-3 flat array: [lineStart, lineEnd, parentStart (-1 if null)]
  const msgIdx: number[] = []
  const metaRanges: Array<[number, number]> = []
  const uuidToSlot = new Map<string, number>()

  let cursor = 0
  while (cursor < len) {
    const nlIdx = buf.indexOf(0x0a, cursor)
    const lineEnd = nlIdx === -1 ? len : nlIdx + 1
    const contentEnd = nlIdx === -1 ? len : nlIdx

    if (
      contentEnd - cursor >= PARENT_PREFIX.length &&
      buf.compare(
        PARENT_PREFIX,
        0,
        PARENT_PREFIX.length,
        cursor,
        cursor + PARENT_PREFIX.length,
      ) === 0
    ) {
      const valuePos = cursor + PARENT_PREFIX.length
      let parentStart = -1
      if (buf[valuePos] === 0x22 && valuePos + 1 + 36 <= contentEnd) {
        parentStart = valuePos + 1
      }
      const slot = msgIdx.length / 3
      msgIdx.push(cursor, lineEnd, parentStart)
      const uuid = extractTopLevelUuidFromLine(buf, cursor, contentEnd)
      if (uuid) {
        uuidToSlot.set(uuid, slot)
      }
    } else {
      metaRanges.push([cursor, lineEnd])
    }

    cursor = lineEnd
  }

  const slotCount = msgIdx.length / 3
  if (slotCount === 0) {
    return buf
  }

  // Locate latest non-sidechain entry as leaf
  let leafSlot = -1
  for (let slot = slotCount - 1; slot >= 0; slot--) {
    const start = msgIdx[slot * 3]!
    const end = msgIdx[slot * 3 + 1]!
    const slice = buf.subarray(start, end)
    if (
      !slice.includes(SIDECHAIN_TRUE_COMPACT) &&
      !slice.includes(SIDECHAIN_TRUE_SPACED)
    ) {
      leafSlot = slot
      break
    }
  }
  if (leafSlot === -1) {
    return buf
  }

  const keptSlots = new Set<number>()
  let chainBytes = 0
  let currentSlot: number | undefined = leafSlot
  while (currentSlot !== undefined && !keptSlots.has(currentSlot)) {
    keptSlots.add(currentSlot)
    const start = msgIdx[currentSlot * 3]!
    const end = msgIdx[currentSlot * 3 + 1]!
    const parentStart = msgIdx[currentSlot * 3 + 2]!
    chainBytes += end - start
    if (parentStart === -1) {
      break
    }
    const parentUuid = buf.toString('latin1', parentStart, parentStart + 36)
    currentSlot = uuidToSlot.get(parentUuid)
  }

  // 50% byte-savings gate avoids memcpy overhead when most bytes are live
  if (len - chainBytes < len >> 1) {
    return buf
  }

  const keptRanges: Array<[number, number]> = [...metaRanges]
  for (const slot of keptSlots) {
    keptRanges.push([msgIdx[slot * 3]!, msgIdx[slot * 3 + 1]!])
  }
  keptRanges.sort((a, b) => a[0] - b[0])

  const parts: Buffer[] = []
  for (const [start, end] of keptRanges) {
    parts.push(buf.subarray(start, end))
  }
  return Buffer.concat(parts)
}

// =============================================================================
// Transcript Parsing, Relinking, & DAG Chain Reconstruction
// =============================================================================

function applyPreservedSegmentRelinks(
  messages: Map<UUID, TranscriptMessage>,
  insertionOrder: readonly UUID[],
): void {
  let absoluteLastBoundaryIdx = -1
  let lastSegBoundaryIdx = -1
  let lastSeg:
    | { headUuid: UUID; anchorUuid: UUID; tailUuid: UUID }
    | undefined

  for (let i = 0; i < insertionOrder.length; i++) {
    const msg = messages.get(insertionOrder[i]!)
    if (msg && isCompactBoundaryMessage(msg)) {
      absoluteLastBoundaryIdx = i
      if (msg.compactMetadata?.preservedSegment) {
        lastSegBoundaryIdx = i
        lastSeg = msg.compactMetadata.preservedSegment
      }
    }
  }

  if (!lastSeg) {
    return
  }

  const segIsLive = lastSegBoundaryIdx === absoluteLastBoundaryIdx
  const preservedUuids = new Set<UUID>()

  if (segIsLive) {
    // Validate tailUuid -> headUuid walk before mutating
    let cursor: UUID | null | undefined = lastSeg.tailUuid
    const walkSeen = new Set<UUID>()
    let reachedHead = false
    while (cursor) {
      if (walkSeen.has(cursor)) break
      walkSeen.add(cursor)
      const node = messages.get(cursor)
      if (!node) break
      preservedUuids.add(cursor)
      if (cursor === lastSeg.headUuid) {
        reachedHead = true
        break
      }
      cursor = node.parentUuid
    }

    if (!reachedHead) {
      logEvent('tengu_relink_walk_broken', {})
      return
    }

    const headNode = messages.get(lastSeg.headUuid)
    if (headNode) {
      headNode.parentUuid = lastSeg.anchorUuid
    }

    for (const [uuid, node] of messages.entries()) {
      if (node.parentUuid === lastSeg.anchorUuid && uuid !== lastSeg.headUuid) {
        node.parentUuid = lastSeg.tailUuid
      }
    }

    // Zero stale usage on preserved assistants so autocompact doesn't immediately re-fire
    for (const uuid of preservedUuids) {
      const node = messages.get(uuid)
      if (node?.type === 'assistant' && node.message.usage) {
        node.message = {
          ...node.message,
          usage: {
            ...node.message.usage,
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        }
      }
    }
  }

  for (let i = 0; i < absoluteLastBoundaryIdx; i++) {
    const uuid = insertionOrder[i]!
    if (!preservedUuids.has(uuid)) {
      messages.delete(uuid)
    }
  }
}

function applySnipRemovals(messages: Map<UUID, TranscriptMessage>): void {
  const toDelete = new Set<UUID>()
  for (const msg of messages.values()) {
    const meta = (msg as { snipMetadata?: { removedUuids?: UUID[] } })
      .snipMetadata
    if (meta?.removedUuids) {
      for (const id of meta.removedUuids) {
        toDelete.add(id)
      }
    }
  }
  if (toDelete.size === 0) {
    return
  }

  const deletedParent = new Map<UUID, UUID | null>()
  for (const id of toDelete) {
    const msg = messages.get(id)
    if (msg) {
      deletedParent.set(id, msg.parentUuid)
      messages.delete(id)
    }
  }

  const resolveAncestor = (start: UUID | null): UUID | null => {
    let curr = start
    const visited = new Set<UUID>()
    while (curr && toDelete.has(curr)) {
      if (visited.has(curr)) return null
      visited.add(curr)
      curr = deletedParent.get(curr) ?? null
    }
    return curr && messages.has(curr) ? curr : null
  }

  for (const msg of messages.values()) {
    if (msg.parentUuid && toDelete.has(msg.parentUuid)) {
      msg.parentUuid = resolveAncestor(msg.parentUuid)
    }
  }

  logEvent('tengu_snip_resume_filtered', { removedCount: toDelete.size })
}

/**
 * Loads and parses a JSONL transcript file into indexed maps, applying >5MB
 * pre-compact skipping, pre-boundary metadata recovery, byte-level dead-branch
 * trimming, legacy progress bridging, preserved-segment relinking, and leaf
 * computation.
 */
export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<LoadedTranscriptData> {
  const result: LoadedTranscriptData = {
    messages: new Map(),
    leafUuids: new Set(),
    summaries: new Map(),
    customTitles: new Map(),
    aiTitles: new Map(),
    lastPrompts: new Map(),
    tags: new Map(),
    agentNames: new Map(),
    agentColors: new Map(),
    agentSettings: new Map(),
    modes: new Map(),
    worktreeSessions: new Map(),
    prLinks: new Map(),
    fileHistorySnapshots: new Map(),
    attributionSnapshots: [],
    contextCollapseCommits: [],
    contextCollapseSnapshot: undefined,
    contentReplacements: [],
    contentReplacementsByAgent: new Map(),
  }

  let st
  try {
    st = await stat(filePath)
  } catch {
    return result
  }
  if (!st.isFile() || st.size === 0) {
    return result
  }

  const disablePrecompactSkip = isEnvTruthy(
    process.env.COPILOT_CLI_DISABLE_PRECOMPACT_SKIP,
  )

  let mainBuf: Buffer
  let preBoundaryMeta: Entry[] = []
  let hasPreservedSegment = false

  if (!disablePrecompactSkip && st.size > SKIP_PRECOMPACT_THRESHOLD) {
    const loaded = await readTranscriptForLoad(filePath, st.size)
    mainBuf = loaded.buffer
    hasPreservedSegment = loaded.hasPreservedSegment
    if (loaded.boundaryStartOffset > 0) {
      preBoundaryMeta = await scanPreBoundaryMetadata(
        filePath,
        loaded.boundaryStartOffset,
      )
    }
  } else {
    mainBuf = await readFile(filePath)
  }

  if (
    !opts?.keepAllLeaves &&
    !hasPreservedSegment &&
    !disablePrecompactSkip &&
    mainBuf.length > SKIP_PRECOMPACT_THRESHOLD
  ) {
    mainBuf = walkChainBeforeParse(mainBuf)
  }

  const entries = [...preBoundaryMeta, ...parseJsonl<Entry>(mainBuf)]
  const insertionOrder: UUID[] = []
  const progressBridge = new Map<UUID, UUID | null>()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue

    // Legacy pre-#24099 progress entries: bridge parentUuid across them
    const rawRec = entry as {
      type?: string
      uuid?: UUID
      parentUuid?: UUID | null
    }
    if (rawRec.type === 'progress' && rawRec.uuid) {
      const bridgedParent =
        rawRec.parentUuid && progressBridge.has(rawRec.parentUuid)
          ? (progressBridge.get(rawRec.parentUuid) ?? null)
          : (rawRec.parentUuid ?? null)
      progressBridge.set(rawRec.uuid, bridgedParent)
      continue
    }

    if (isTranscriptMessage(entry)) {
      if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
        entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
      }
      if (isCompactBoundaryMessage(entry)) {
        result.contextCollapseCommits.length = 0
        result.contextCollapseSnapshot = undefined
      }
      if (!result.messages.has(entry.uuid)) {
        insertionOrder.push(entry.uuid)
      }
      result.messages.set(entry.uuid, entry)
      continue
    }

    switch (entry.type) {
      case 'summary':
        result.summaries.set(entry.leafUuid, entry.summary)
        break
      case 'custom-title':
        result.customTitles.set(entry.sessionId, entry.customTitle)
        break
      case 'ai-title':
        result.aiTitles.set(entry.sessionId, entry.aiTitle)
        break
      case 'last-prompt':
        result.lastPrompts.set(entry.sessionId, entry.lastPrompt)
        break
      case 'tag':
        result.tags.set(entry.sessionId, entry.tag)
        break
      case 'agent-name':
        result.agentNames.set(entry.sessionId, entry.agentName)
        break
      case 'agent-color':
        result.agentColors.set(entry.sessionId, entry.agentColor)
        break
      case 'agent-setting':
        result.agentSettings.set(entry.sessionId, entry.agentSetting)
        break
      case 'mode':
        result.modes.set(entry.sessionId, entry.mode)
        break
      case 'worktree-state':
        result.worktreeSessions.set(entry.sessionId, entry.worktreeSession)
        break
      case 'pr-link':
        result.prLinks.set(entry.sessionId, {
          prNumber: entry.prNumber,
          prUrl: entry.prUrl,
          prRepository: entry.prRepository,
        })
        break
      case 'file-history-snapshot':
        result.fileHistorySnapshots.set(entry.messageId, entry)
        break
      case 'attribution-snapshot':
        result.attributionSnapshots.push(entry)
        break
      case 'marble-origami-commit':
        result.contextCollapseCommits.push(entry)
        break
      case 'marble-origami-snapshot':
        result.contextCollapseSnapshot = entry
        break
      case 'content-replacement':
        if (entry.agentId) {
          const list = result.contentReplacementsByAgent.get(entry.agentId) ?? []
          list.push(...entry.replacements)
          result.contentReplacementsByAgent.set(entry.agentId, list)
        } else {
          result.contentReplacements.push(...entry.replacements)
        }
        break
      default:
        break
    }
  }

  applyPreservedSegmentRelinks(result.messages, insertionOrder)
  applySnipRemovals(result.messages)

  // Compute leafUuids
  const parentUuids = new Set<UUID>()
  const userOrAssistantParents = new Set<UUID>()
  for (const msg of result.messages.values()) {
    if (msg.parentUuid) {
      parentUuids.add(msg.parentUuid)
      if (msg.type === 'user' || msg.type === 'assistant') {
        userOrAssistantParents.add(msg.parentUuid)
      }
    }
  }

  for (const msg of result.messages.values()) {
    if (parentUuids.has(msg.uuid)) continue
    let curr: TranscriptMessage | undefined = msg
    const walkSeen = new Set<UUID>()
    while (curr) {
      if (walkSeen.has(curr.uuid)) {
        logEvent('tengu_transcript_parent_cycle', {})
        break
      }
      walkSeen.add(curr.uuid)
      if (curr.type === 'user' || curr.type === 'assistant') {
        if (!userOrAssistantParents.has(curr.uuid)) {
          result.leafUuids.add(curr.uuid)
        }
        break
      }
      curr = curr.parentUuid ? result.messages.get(curr.parentUuid) : undefined
    }
  }

  // Fallback if pruning eliminated all leaves
  if (result.leafUuids.size === 0 && result.messages.size > 0) {
    for (let i = insertionOrder.length - 1; i >= 0; i--) {
      const m = result.messages.get(insertionOrder[i]!)
      if (m && (m.type === 'user' || m.type === 'assistant')) {
        result.leafUuids.add(m.uuid)
        break
      }
    }
  }

  return result
}

function isToolResultTranscriptMessage(msg: TranscriptMessage): boolean {
  if (msg.type !== 'user' || !Array.isArray(msg.message.content)) {
    return false
  }
  return msg.message.content.some(b => b.type === 'tool_result')
}

/**
 * O(n) repair for parallel streaming `tool_use` / `tool_result` DAG branches:
 * Streaming emits distinct `uuid`s sharing the same assistant `message.id`, and
 * parallel `tool_result` messages parent to their originating assistant UUID.
 * Walking a single parent chain misses sibling assistants and their tool results;
 * this splices every off-chain sibling and its `tool_result`s directly after
 * the last on-chain assistant sharing that `message.id`.
 */
export function recoverOrphanedParallelToolResults(
  messages: ReadonlyMap<UUID, TranscriptMessage>,
  chain: TranscriptMessage[],
  seen: Set<UUID>,
): TranscriptMessage[] {
  const anchorByMsgId = new Map<string, TranscriptMessage>()
  for (const msg of chain) {
    if (msg.type === 'assistant' && msg.message.id) {
      anchorByMsgId.set(msg.message.id, msg)
    }
  }
  if (anchorByMsgId.size === 0) {
    return chain
  }

  const siblingsByMsgId = new Map<string, TranscriptMessage[]>()
  const toolResultsByAsst = new Map<UUID, TranscriptMessage[]>()

  for (const msg of messages.values()) {
    if (msg.type === 'assistant' && msg.message.id) {
      let group = siblingsByMsgId.get(msg.message.id)
      if (!group) {
        group = []
        siblingsByMsgId.set(msg.message.id, group)
      }
      group.push(msg)
    } else if (isToolResultTranscriptMessage(msg) && msg.parentUuid) {
      let trList = toolResultsByAsst.get(msg.parentUuid)
      if (!trList) {
        trList = []
        toolResultsByAsst.set(msg.parentUuid, trList)
      }
      trList.push(msg)
    }
  }

  const inserts = new Map<UUID, TranscriptMessage[]>()
  let recoveredCount = 0

  for (const [msgId, anchor] of anchorByMsgId.entries()) {
    const group = siblingsByMsgId.get(msgId)
    if (!group || group.length === 0) continue

    const orphanedSiblings: TranscriptMessage[] = []
    const orphanedToolResults: TranscriptMessage[] = []

    for (const sibling of group) {
      if (!seen.has(sibling.uuid)) {
        orphanedSiblings.push(sibling)
      }
      const trs = toolResultsByAsst.get(sibling.uuid)
      if (trs) {
        for (const tr of trs) {
          if (!seen.has(tr.uuid)) {
            orphanedToolResults.push(tr)
          }
        }
      }
    }

    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) {
      continue
    }

    orphanedSiblings.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    orphanedToolResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

    for (const s of orphanedSiblings) {
      seen.add(s.uuid)
    }
    for (const tr of orphanedToolResults) {
      seen.add(tr.uuid)
    }

    const toInsert = [...orphanedSiblings, ...orphanedToolResults]
    recoveredCount += toInsert.length
    inserts.set(anchor.uuid, toInsert)
  }

  if (inserts.size === 0) {
    return chain
  }

  logEvent('tengu_chain_parallel_tr_recovered', { recoveredCount })

  const repaired: TranscriptMessage[] = []
  for (const msg of chain) {
    repaired.push(msg)
    const extra = inserts.get(msg.uuid)
    if (extra) {
      repaired.push(...extra)
    }
  }
  return repaired
}

/**
 * Reconstructs the linear root-to-leaf conversation chain from a DAG map of
 * transcript messages, protecting against cycles and repairing orphaned
 * parallel `tool_use` / `tool_result` siblings.
 */
export function buildConversationChain(
  messages: ReadonlyMap<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const reversed: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let current: TranscriptMessage | undefined = leafMessage

  while (current) {
    if (seen.has(current.uuid)) {
      logError(
        new Error(`Parent UUID cycle detected in transcript at ${current.uuid}`),
      )
      logEvent('tengu_chain_parent_cycle', {})
      break
    }
    seen.add(current.uuid)
    reversed.push(current)
    current = current.parentUuid
      ? messages.get(current.parentUuid)
      : undefined
  }

  const ordered = reversed.reverse()
  return recoverOrphanedParallelToolResults(messages, ordered, seen)
}

/**
 * Walks the active reconstructed conversation chain and builds the winning
 * sequence of `FileHistorySnapshot` checkpoints (applying `isSnapshotUpdate`
 * replacements in place while automatically excluding rewound dead branches).
 */
export function buildFileHistorySnapshotChain(
  fileHistorySnapshots: ReadonlyMap<UUID, FileHistorySnapshotMessage>,
  conversation: readonly TranscriptMessage[],
): FileHistorySnapshot[] {
  const snapshots: FileHistorySnapshot[] = []
  const indexByMessageId = new Map<UUID, number>()

  for (const msg of conversation) {
    const entry = fileHistorySnapshots.get(msg.uuid)
    if (!entry) continue
    if (entry.isSnapshotUpdate) {
      const existingIdx = indexByMessageId.get(entry.snapshot.messageId)
      if (existingIdx !== undefined) {
        snapshots[existingIdx] = entry.snapshot
      } else {
        indexByMessageId.set(entry.snapshot.messageId, snapshots.length)
        snapshots.push(entry.snapshot)
      }
    } else {
      indexByMessageId.set(entry.snapshot.messageId, snapshots.length)
      snapshots.push(entry.snapshot)
    }
  }

  return snapshots
}

/**
 * Emits consistency telemetry comparing reconstructed chain length against
 * the latest `turn_duration.messageCount` checkpoint.
 */
export function checkResumeConsistency(
  messages: readonly Message[],
): { delta: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (
      msg.type === 'system' &&
      msg.subtype === 'turn_duration' &&
      msg.messageCount !== undefined
    ) {
      const delta = i - msg.messageCount
      logEvent('tengu_resume_consistency_delta', {
        delta,
        actual: i,
        expected: msg.messageCount,
      })
      return { delta }
    }
  }
  return null
}

// =============================================================================
// Session Discovery, 64KB Lite Listing, Enrichment & Full Log Loading
// =============================================================================

/**
 * Lists valid UUID `.jsonl` session candidate files in `dir` (excluding
 * `agent-*.jsonl` sidechain transcripts when `excludeAgentFiles` is true).
 */
export async function listCandidates(
  dir: string,
  excludeAgentFiles = true,
): Promise<SessionCandidate[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const results = await Promise.all(
    names.map(async (name): Promise<SessionCandidate | null> => {
      if (!name.endsWith('.jsonl')) return null
      if (excludeAgentFiles && name.startsWith('agent-')) return null
      const base = name.slice(0, -'.jsonl'.length)
      const validUuid = validateUuid(base)
      if (!validUuid) return null
      const fullPath = join(dir, name)
      try {
        const st = await stat(fullPath)
        if (!st.isFile() || st.size <= 0) return null
        return {
          sessionId: validUuid as UUID,
          fullPath,
          mtime: st.mtimeMs,
          ctime: st.birthtimeMs || st.ctimeMs,
          size: st.size,
        }
      } catch {
        return null
      }
    }),
  )

  return results.filter((c): c is SessionCandidate => c !== null)
}

export function isLiteLog(log: LogOption): boolean {
  return Boolean(log.isLite || (log.messages.length === 0 && log.sessionId))
}

function getFirstMeaningfulUserMessageText(
  messages: readonly TranscriptMessage[],
): string {
  for (const msg of messages) {
    if (msg.type !== 'user' || msg.isMeta || msg.isCompactSummary) continue
    const prompt = extractCompactLastPrompt(msg)
    if (prompt) return prompt
  }
  return '(session)'
}

/**
 * Lists lightweight stat-only `LogOption` entries for a project directory
 * (and optional sibling git worktrees), sorted newest-first.
 */
export async function getSessionFilesLite(
  projectPath: string = getOriginalCwd(),
  options?: { includeWorktrees?: boolean },
): Promise<LogOption[]> {
  const dirsToScan = new Set<string>([getProjectDir(projectPath)])

  if (options?.includeWorktrees) {
    const worktrees: string[] = getActiveRepoWorktreePaths(projectPath)
    const projectsRoot = getProjectsDir()
    const prefixes = worktrees
      .map((wt: string) => sanitizePath(wt))
      .sort((a: string, b: string) => b.length - a.length)
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const nameLower =
          process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
        const matches = prefixes.some(p => {
          const pCmp = process.platform === 'win32' ? p.toLowerCase() : p
          if (nameLower === pCmp) return true
          return (
            pCmp.length >= MAX_SANITIZED_LENGTH &&
            nameLower.startsWith(`${pCmp}-`)
          )
        })
        if (matches) {
          dirsToScan.add(join(projectsRoot, entry.name))
        }
      }
    } catch {
      // Ignore missing projects root
    }
    for (const wt of worktrees) {
      dirsToScan.add(getProjectDir(wt))
    }
  }

  const candidateLists = await Promise.all(
    Array.from(dirsToScan).map(dir => listCandidates(dir, true)),
  )

  const seenBySessionId = new Map<string, SessionCandidate>()
  for (const list of candidateLists) {
    for (const cand of list) {
      const existing = seenBySessionId.get(cand.sessionId)
      if (!existing || cand.mtime > existing.mtime) {
        seenBySessionId.set(cand.sessionId, cand)
      }
    }
  }

  const logs: LogOption[] = Array.from(seenBySessionId.values()).map(
    (cand, idx) => ({
      date: new Date(cand.mtime).toISOString(),
      messages: [],
      fullPath: cand.fullPath,
      value: idx,
      created: new Date(cand.ctime),
      modified: new Date(cand.mtime),
      firstPrompt: '',
      messageCount: 0,
      fileSize: cand.size,
      isSidechain: false,
      isLite: true,
      sessionId: cand.sessionId,
      projectPath,
    }),
  )

  return sortLogs(logs)
}

/**
 * Enriches a single lite `LogOption` using a 64KB head/tail scan. Returns
 * `null` for sidechain or teammate sessions that should be filtered out.
 */
export async function enrichLog(
  log: LogOption,
  sharedBuf?: Buffer,
): Promise<LogOption | null> {
  if (!log.fullPath) return log
  const fileSize = log.fileSize ?? (await stat(log.fullPath).catch(() => null))?.size ?? 0
  if (fileSize <= 0) return null

  const buf = sharedBuf ?? Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
  const { head, tail } = await readHeadAndTail(log.fullPath, fileSize, buf)
  if (!head && !tail) return null

  if (
    head.includes('"isSidechain":true') ||
    head.includes('"isSidechain": true')
  ) {
    return null
  }
  const teamName = extractJsonStringField(head, 'teamName')
  if (teamName) {
    return null
  }

  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractJsonStringField(head, 'aiTitle')

  const lastPrompt = extractLastJsonStringField(tail, 'lastPrompt')
  const firstPromptRaw =
    lastPrompt ??
    extractFirstPromptFromHead(head, {
      keepCustomCommandWithArgs: true,
      proactiveTickFallback: true,
    }) ??
    extractJsonStringFieldPrefix(head, 'content', 200) ??
    extractJsonStringFieldPrefix(head, 'text', 200) ??
    ''

  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ??
    extractJsonStringField(head, 'gitBranch')
  const cwdFromHead = extractJsonStringField(head, 'cwd')
  const agentSetting = extractJsonStringField(head, 'agentSetting')
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumIdx = tail.lastIndexOf('"prNumber":')
  if (prNumIdx !== -1) {
    const parsedNum = Number.parseInt(tail.slice(prNumIdx + 11, prNumIdx + 24).trim(), 10)
    if (Number.isFinite(parsedNum)) {
      prNumber = parsedNum
    }
  }

  const firstPrompt = firstPromptRaw || (customTitle ? '' : '(session)')

  return {
    ...log,
    fileSize,
    firstPrompt,
    ...(customTitle ? { customTitle } : {}),
    ...(summary ? { summary } : {}),
    ...(tag ? { tag } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    ...(cwdFromHead ? { projectPath: cwdFromHead } : {}),
    ...(agentSetting ? { agentSetting } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(prRepository ? { prRepository } : {}),
  }
}

/**
 * Enriches a slice of lite logs reusing one 64KB buffer.
 */
export async function enrichLogs(
  logs: readonly LogOption[],
  startIndex = 0,
  count: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const sharedBuf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE)
  const slice = logs.slice(startIndex, startIndex + count)
  const enriched: LogOption[] = []
  for (const log of slice) {
    const res = await enrichLog(log, sharedBuf)
    if (res) {
      enriched.push(res)
    }
  }
  return enriched
}

function stripTranscriptExtraFields(
  msg: TranscriptMessage,
): SerializedMessage {
  const copy = { ...msg } as Record<string, unknown>
  delete copy.parentUuid
  delete copy.isSidechain
  return copy as unknown as SerializedMessage
}

/**
 * Upgrades a lite `LogOption` to a fully parsed conversation chain with
 * metadata, snapshots, attribution, and content replacement records.
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  if (!log.fullPath) return log
  const loaded = await loadTranscriptFile(log.fullPath)
  if (loaded.messages.size === 0) {
    return { ...log, isLite: false, messages: [] }
  }

  let bestLeaf: TranscriptMessage | undefined
  for (const leafId of loaded.leafUuids) {
    const msg = loaded.messages.get(leafId)
    if (!msg || msg.isSidechain) continue
    if (!bestLeaf || msg.timestamp > bestLeaf.timestamp) {
      bestLeaf = msg
    }
  }
  if (!bestLeaf) {
    for (const msg of loaded.messages.values()) {
      if (!msg.isSidechain && (!bestLeaf || msg.timestamp > bestLeaf.timestamp)) {
        bestLeaf = msg
      }
    }
  }
  if (!bestLeaf) {
    return { ...log, isLite: false, messages: [] }
  }

  const chain = buildConversationChain(loaded.messages, bestLeaf)
  const sessionId = (bestLeaf.sessionId || log.sessionId || '') as UUID
  const fileHistorySnapshots = buildFileHistorySnapshotChain(
    loaded.fileHistorySnapshots,
    chain,
  )

  const customTitle =
    loaded.customTitles.get(sessionId) ??
    loaded.aiTitles.get(sessionId) ??
    log.customTitle
  const summary = loaded.summaries.get(bestLeaf.uuid) ?? log.summary
  const tag = loaded.tags.get(sessionId) ?? log.tag
  const agentName = loaded.agentNames.get(sessionId) ?? log.agentName
  const agentColor = loaded.agentColors.get(sessionId) ?? log.agentColor
  const agentSetting = loaded.agentSettings.get(sessionId) ?? log.agentSetting
  const mode = loaded.modes.get(sessionId) ?? log.mode
  const worktreeSession = loaded.worktreeSessions.has(sessionId)
    ? loaded.worktreeSessions.get(sessionId)
    : log.worktreeSession
  const prLink = loaded.prLinks.get(sessionId)
  const firstPrompt =
    loaded.lastPrompts.get(sessionId) ??
    (log.firstPrompt && log.firstPrompt !== '(session)'
      ? log.firstPrompt
      : getFirstMeaningfulUserMessageText(chain))

  return {
    ...log,
    isLite: false,
    sessionId: sessionId || log.sessionId,
    leafUuid: bestLeaf.uuid,
    messages: chain.map(stripTranscriptExtraFields),
    messageCount: chain.length,
    firstPrompt,
    ...(customTitle ? { customTitle } : {}),
    ...(summary ? { summary } : {}),
    ...(tag ? { tag } : {}),
    ...(agentName ? { agentName } : {}),
    ...(agentColor ? { agentColor } : {}),
    ...(agentSetting ? { agentSetting } : {}),
    ...(mode ? { mode } : {}),
    ...(worktreeSession !== undefined ? { worktreeSession } : {}),
    ...(prLink
      ? {
          prNumber: prLink.prNumber,
          prUrl: prLink.prUrl,
          prRepository: prLink.prRepository,
        }
      : {}),
    fileHistorySnapshots,
    attributionSnapshots: loaded.attributionSnapshots,
    contextCollapseCommits: loaded.contextCollapseCommits,
    contextCollapseSnapshot: loaded.contextCollapseSnapshot,
    contentReplacements: loaded.contentReplacements,
  }
}

/**
 * Loads enriched lite logs for the current project (most recent first).
 */
export async function loadMessageLogs(
  projectPath: string = getOriginalCwd(),
  options?: { includeWorktrees?: boolean; limit?: number },
): Promise<LogOption[]> {
  const lite = await getSessionFilesLite(projectPath, {
    includeWorktrees: options?.includeWorktrees,
  })
  return enrichLogs(lite, 0, options?.limit ?? INITIAL_ENRICH_COUNT)
}

/**
 * Loads a specific session log by `sessionId` (priming the session message set
 * cache so subsequent writes deduplicate cleanly).
 */
export async function getLastSessionLog(
  sessionId: UUID,
  projectPath: string = getOriginalCwd(),
): Promise<LogOption | null> {
  const fullPath = getTranscriptPathForSession(sessionId, projectPath)
  let st
  try {
    st = await stat(fullPath)
  } catch {
    return null
  }
  if (!st.isFile() || st.size <= 0) {
    return null
  }

  const baseLog: LogOption = {
    date: st.mtime.toISOString(),
    messages: [],
    fullPath,
    value: 0,
    created: st.birthtime,
    modified: st.mtime,
    firstPrompt: '',
    messageCount: 0,
    fileSize: st.size,
    isSidechain: false,
    isLite: true,
    sessionId,
    projectPath,
  }

  const loaded = await loadFullLog(baseLog)
  getProject().primeSessionMessageSet(
    sessionId,
    loaded.messages.map(m => m.uuid),
  )
  return loaded
}

/**
 * Loads a conversation directly from an arbitrary `.jsonl` file path.
 */
export async function loadMessagesFromJsonlPath(
  filePath: string,
): Promise<LogOption | null> {
  let st
  try {
    st = await stat(filePath)
  } catch {
    return null
  }
  if (!st.isFile() || st.size <= 0) {
    return null
  }
  const stem = basename(filePath, '.jsonl')
  const validUuid = validateUuid(stem)

  return loadFullLog({
    date: st.mtime.toISOString(),
    messages: [],
    fullPath: filePath,
    value: 0,
    created: st.birthtime,
    modified: st.mtime,
    firstPrompt: '',
    messageCount: 0,
    fileSize: st.size,
    isSidechain: false,
    isLite: true,
    sessionId: validUuid ?? undefined,
  })
}

/**
 * Searches saved sessions by custom title (exact or case-insensitive substring).
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { exact?: boolean; projectPath?: string },
): Promise<LogOption[]> {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const logs = await loadMessageLogs(options?.projectPath ?? getOriginalCwd(), {
    includeWorktrees: true,
    limit: 200,
  })
  return logs.filter(log => {
    const title = (log.customTitle ?? '').trim().toLowerCase()
    if (!title) return false
    return options?.exact ? title === normalized : title.includes(normalized)
  })
}

export type { AssistantMessage }
