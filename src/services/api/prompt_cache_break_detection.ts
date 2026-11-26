/**
 * Two-stage Prompt Cache invalidation detector:
 * - Stage 1 (`recordPromptState`): pre-request structural hashing of system
 *   prompt, tools, cache_control metadata, model, betas, effort, and extraBody.
 * - Stage 2 (`checkResponseForCacheBreak`): post-response verification detecting
 *   >5% AND >=2,000-token cache_read drops, classifying causes (prompt changes,
 *   5m/1h TTL expiry, or server-side), and writing unified diffs to temp dir.
 */

import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QuerySource } from '../../constants/query_source.js'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utilities/debug.js'
import { jsonStringify } from '../../utilities/slow_operations.js'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../analytics/index.js'
import type { GlobalCacheStrategy } from './logging.js'

export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
const MIN_CACHE_MISS_TOKENS = 2_000
const MAX_TRACKED_SOURCES = 10

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
] as const

export interface PromptStateSnapshot {
  querySource: QuerySource | undefined
  agentId?: string
  model: string
  system: ReadonlyArray<Record<string, unknown>>
  toolSchemas: ReadonlyArray<Record<string, unknown>>
  betas: readonly string[]
  fastMode?: boolean
  globalCacheStrategy?: GlobalCacheStrategy
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMcEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: Record<string, unknown>
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMcChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  addedBetas: string[]
  removedBetas: string[]
  systemCharDelta: number
  buildPrevDiffableContent: () => string
}

interface TrackedSourceState {
  callCount: number
  systemHash: number
  toolsHash: number
  cacheControlHash: number
  perToolHashes: Map<string, number>
  model: string
  fastMode: boolean
  globalCacheStrategy: GlobalCacheStrategy
  betas: string[]
  autoModeActive: boolean
  isUsingOverage: boolean
  cachedMcEnabled: boolean
  effortValue: string
  extraBodyHash: number
  systemCharCount: number
  buildDiffableContent: () => string
  prevCacheReadTokens: number | null
  cacheDeletionsPending: boolean
  pendingChanges: PendingChanges | null
}

const trackedStates = new Map<string, TrackedSourceState>()

function getTrackingKey(
  querySource: QuerySource | undefined,
  agentId?: string,
): string | null {
  if (!querySource) {
    return null
  }
  if (querySource === 'compact') {
    return 'repl_main_thread'
  }
  const tracked = TRACKED_SOURCE_PREFIXES.some(prefix =>
    querySource.startsWith(prefix),
  )
  if (!tracked) {
    return null
  }
  return agentId || querySource
}

function isExcludedModel(model: string): boolean {
  return model.toLowerCase().includes('haiku')
}

function djb2Hash(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash
}

function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined' && typeof Bun.hash === 'function') {
    const raw = Bun.hash(str)
    return typeof raw === 'bigint' ? Number(raw & 0xffffffffn) : Number(raw)
  }
  return djb2Hash(str)
}

function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return items.map(item => {
    if (!('cache_control' in item)) {
      return item
    }
    const copy = { ...item }
    delete copy.cache_control
    return copy
  })
}

function buildPerToolHashes(
  toolSchemas: ReadonlyArray<Record<string, unknown>>,
): Map<string, number> {
  const map = new Map<string, number>()
  for (const tool of stripCacheControl(toolSchemas)) {
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (name) {
      map.set(name, computeHash(tool))
    }
  }
  return map
}

function sanitizeToolNamesForTelemetry(names: readonly string[]): string {
  return names
    .map(name => (name.startsWith('mcp__') ? 'mcp' : name))
    .join(',')
}

function createDiffableContentBuilder(
  model: string,
  system: ReadonlyArray<Record<string, unknown>>,
  toolSchemas: ReadonlyArray<Record<string, unknown>>,
): () => string {
  return () => {
    const lines: string[] = [`Model: ${model}`, '', '=== System Prompt ===']
    for (const block of system) {
      if (typeof block.text === 'string') {
        lines.push(block.text)
      }
    }
    const sortedTools = [...toolSchemas].sort((a, b) =>
      String(a.name ?? '').localeCompare(String(b.name ?? '')),
    )
    lines.push('', `=== Tools (${sortedTools.length}) ===`)
    for (const tool of sortedTools) {
      lines.push(
        `Tool: ${String(tool.name ?? '')}`,
        `Description: ${String(tool.description ?? '')}`,
        `Schema: ${jsonStringify(tool.input_schema ?? {})}`,
        '',
      )
    }
    return lines.join('\n')
  }
}

function countSystemChars(
  system: ReadonlyArray<Record<string, unknown>>,
): number {
  let count = 0
  for (const block of system) {
    if (typeof block.text === 'string') {
      count += block.text.length
    }
  }
  return count
}

/**
 * Stage 1: Records pre-request prompt structure hashes and computes any diffs
 * against the previous turn for the same tracked source.
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  const key = getTrackingKey(snapshot.querySource, snapshot.agentId)
  if (!key || isExcludedModel(snapshot.model)) {
    return
  }

  const nonDeferredTools = snapshot.toolSchemas.filter(
    tool => tool.defer_loading !== true,
  )
  const strippedSystem = stripCacheControl(snapshot.system)
  const strippedTools = stripCacheControl(nonDeferredTools)

  const systemHash = computeHash(strippedSystem)
  const toolsHash = computeHash(strippedTools)
  const cacheControlHash = computeHash(
    snapshot.system.map(block =>
      'cache_control' in block ? block.cache_control : null,
    ),
  )
  const sortedBetas = [...snapshot.betas].sort()
  const fastMode = Boolean(snapshot.fastMode)
  const globalCacheStrategy: GlobalCacheStrategy =
    snapshot.globalCacheStrategy ?? 'none'
  const autoModeActive = Boolean(snapshot.autoModeActive)
  const isUsingOverage = Boolean(snapshot.isUsingOverage)
  const cachedMcEnabled = Boolean(snapshot.cachedMcEnabled)
  const effortValue =
    snapshot.effortValue !== undefined ? String(snapshot.effortValue) : ''
  const extraBodyHash =
    snapshot.extraBodyParams && Object.keys(snapshot.extraBodyParams).length > 0
      ? computeHash(snapshot.extraBodyParams)
      : 0
  const systemCharCount = countSystemChars(snapshot.system)
  const buildDiffableContent = createDiffableContentBuilder(
    snapshot.model,
    snapshot.system,
    nonDeferredTools,
  )

  const prev = trackedStates.get(key)
  if (!prev) {
    if (trackedStates.size >= MAX_TRACKED_SOURCES) {
      const oldestKey = trackedStates.keys().next().value
      if (oldestKey !== undefined) {
        trackedStates.delete(oldestKey)
      }
    }
    trackedStates.set(key, {
      callCount: 1,
      systemHash,
      toolsHash,
      cacheControlHash,
      perToolHashes: buildPerToolHashes(nonDeferredTools),
      model: snapshot.model,
      fastMode,
      globalCacheStrategy,
      betas: sortedBetas,
      autoModeActive,
      isUsingOverage,
      cachedMcEnabled,
      effortValue,
      extraBodyHash,
      systemCharCount,
      buildDiffableContent,
      prevCacheReadTokens: null,
      cacheDeletionsPending: false,
      pendingChanges: null,
    })
    return
  }

  prev.callCount++

  const systemPromptChanged = prev.systemHash !== systemHash
  const toolSchemasChanged = prev.toolsHash !== toolsHash
  const modelChanged = prev.model !== snapshot.model
  const fastModeChanged = prev.fastMode !== fastMode
  const cacheControlChanged = prev.cacheControlHash !== cacheControlHash
  const globalCacheStrategyChanged =
    prev.globalCacheStrategy !== globalCacheStrategy
  const betasChanged =
    prev.betas.length !== sortedBetas.length ||
    prev.betas.some((b, idx) => b !== sortedBetas[idx])
  const autoModeChanged = prev.autoModeActive !== autoModeActive
  const overageChanged = prev.isUsingOverage !== isUsingOverage
  const cachedMcChanged = prev.cachedMcEnabled !== cachedMcEnabled
  const effortChanged = prev.effortValue !== effortValue
  const extraBodyChanged = prev.extraBodyHash !== extraBodyHash

  const addedTools: string[] = []
  const removedTools: string[] = []
  const changedToolSchemas: string[] = []
  let nextPerToolHashes = prev.perToolHashes

  if (toolSchemasChanged) {
    nextPerToolHashes = buildPerToolHashes(nonDeferredTools)
    for (const [name, hash] of nextPerToolHashes) {
      if (!prev.perToolHashes.has(name)) {
        addedTools.push(name)
      } else if (prev.perToolHashes.get(name) !== hash) {
        changedToolSchemas.push(name)
      }
    }
    for (const name of prev.perToolHashes.keys()) {
      if (!nextPerToolHashes.has(name)) {
        removedTools.push(name)
      }
    }
  }

  const prevBetaSet = new Set(prev.betas)
  const nextBetaSet = new Set(sortedBetas)
  const addedBetas = sortedBetas.filter(b => !prevBetaSet.has(b))
  const removedBetas = prev.betas.filter(b => !nextBetaSet.has(b))
  const systemCharDelta = systemCharCount - prev.systemCharCount

  const anyChanged =
    systemPromptChanged ||
    toolSchemasChanged ||
    modelChanged ||
    fastModeChanged ||
    cacheControlChanged ||
    globalCacheStrategyChanged ||
    betasChanged ||
    autoModeChanged ||
    overageChanged ||
    cachedMcChanged ||
    effortChanged ||
    extraBodyChanged

  const buildPrevDiffableContent = prev.buildDiffableContent

  prev.pendingChanges = anyChanged
    ? {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMcChanged,
        effortChanged,
        extraBodyChanged,
        addedTools,
        removedTools,
        changedToolSchemas,
        addedBetas,
        removedBetas,
        systemCharDelta,
        buildPrevDiffableContent,
      }
    : null

  prev.systemHash = systemHash
  prev.toolsHash = toolsHash
  prev.cacheControlHash = cacheControlHash
  prev.perToolHashes = nextPerToolHashes
  prev.model = snapshot.model
  prev.fastMode = fastMode
  prev.globalCacheStrategy = globalCacheStrategy
  prev.betas = sortedBetas
  prev.autoModeActive = autoModeActive
  prev.isUsingOverage = isUsingOverage
  prev.cachedMcEnabled = cachedMcEnabled
  prev.effortValue = effortValue
  prev.extraBodyHash = extraBodyHash
  prev.systemCharCount = systemCharCount
  prev.buildDiffableContent = buildDiffableContent
}

export interface CacheBreakDiagnosis {
  detected: boolean
  reason?: string
  tokenDrop?: number
  prevCacheReadTokens?: number
  cacheReadTokens?: number
  diffPath?: string
}

/**
 * Stage 2: Compares response `cache_read_input_tokens` against the prior turn
 * and classifies any unexpected >5% and >=2,000-token cache drop.
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource | undefined,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: readonly Message[],
  agentId?: string,
  requestId?: string,
): Promise<CacheBreakDiagnosis> {
  const key = getTrackingKey(querySource, agentId)
  if (!key) {
    return { detected: false }
  }
  const state = trackedStates.get(key)
  if (!state || isExcludedModel(state.model)) {
    return { detected: false }
  }

  const prevCacheRead = state.prevCacheReadTokens
  state.prevCacheReadTokens = cacheReadTokens

  if (prevCacheRead === null) {
    state.pendingChanges = null
    return { detected: false }
  }

  if (state.cacheDeletionsPending) {
    state.cacheDeletionsPending = false
    state.pendingChanges = null
    logForDebugging(
      `[PROMPT CACHE] Expected cache read drop after cache deletion (${prevCacheRead} -> ${cacheReadTokens})`,
    )
    return { detected: false }
  }

  const tokenDrop = prevCacheRead - cacheReadTokens
  if (!(cacheReadTokens < prevCacheRead * 0.95 && tokenDrop >= MIN_CACHE_MISS_TOKENS)) {
    state.pendingChanges = null
    return { detected: false }
  }

  const changes = state.pendingChanges
  state.pendingChanges = null

  let timeSinceLastAssistantMs: number | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const ts = Date.parse(msg.timestamp)
      if (!Number.isNaN(ts)) {
        timeSinceLastAssistantMs = Date.now() - ts
      }
      break
    }
  }

  const parts: string[] = []
  if (changes) {
    if (changes.modelChanged) parts.push('model changed')
    if (changes.systemPromptChanged) {
      parts.push(`system prompt changed (delta ${changes.systemCharDelta} chars)`)
    }
    if (changes.toolSchemasChanged) {
      const details: string[] = []
      if (changes.addedTools.length > 0) {
        details.push(`+${changes.addedTools.length} tools`)
      }
      if (changes.removedTools.length > 0) {
        details.push(`-${changes.removedTools.length} tools`)
      }
      if (changes.changedToolSchemas.length > 0) {
        details.push(`~${changes.changedToolSchemas.length} tool schemas`)
      }
      parts.push(
        details.length > 0
          ? `tools changed (${details.join(', ')})`
          : 'tools changed',
      )
    }
    if (changes.globalCacheStrategyChanged) {
      parts.push('global cache strategy changed')
    } else if (changes.cacheControlChanged && !changes.systemPromptChanged) {
      parts.push('cache_control changed')
    }
    if (changes.betasChanged) parts.push('betas changed')
    if (changes.fastModeChanged) parts.push('fastMode changed')
    if (changes.autoModeChanged) parts.push('autoMode changed')
    if (changes.overageChanged) parts.push('overage changed')
    if (changes.cachedMcChanged) parts.push('cachedMC changed')
    if (changes.effortChanged) parts.push('effort changed')
    if (changes.extraBodyChanged) parts.push('extraBody changed')
  }

  let reason: string
  if (parts.length > 0) {
    reason = parts.join(', ')
  } else if (
    timeSinceLastAssistantMs !== null &&
    timeSinceLastAssistantMs > CACHE_TTL_1HOUR_MS
  ) {
    reason = 'possible 1h TTL expiry (prompt unchanged)'
  } else if (
    timeSinceLastAssistantMs !== null &&
    timeSinceLastAssistantMs > CACHE_TTL_5MIN_MS
  ) {
    reason = 'possible 5min TTL expiry (prompt unchanged)'
  } else if (timeSinceLastAssistantMs !== null) {
    reason = 'likely server-side (prompt unchanged, <5min gap)'
  } else {
    reason = 'unknown cause'
  }

  let diffPath: string | undefined
  if (changes?.buildPrevDiffableContent) {
    try {
      const before = changes.buildPrevDiffableContent()
      const after = state.buildDiffableContent()
      if (before !== after) {
        const patch = createPatch('prompt-state', before, after, 'before', 'after')
        const tempDir = join(tmpdir(), 'claude')
        await mkdir(tempDir, { recursive: true })
        const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
        diffPath = join(tempDir, `cache-break-${suffix}.diff`)
        await writeFile(diffPath, patch, 'utf-8')
      }
    } catch {
      // Non-fatal diff diagnostic error
    }
  }

  logEvent('tengu_prompt_cache_break', {
    reason: reason as VerifiedNonSensitiveAnalyticsMetadata,
    prevCacheReadTokens: prevCacheRead,
    cacheReadTokens,
    cacheCreationTokens,
    tokenDrop,
    callCount: state.callCount,
    ...(requestId
      ? { requestId: requestId as VerifiedNonSensitiveAnalyticsMetadata }
      : {}),
    ...(changes?.addedTools.length
      ? {
          addedTools: sanitizeToolNamesForTelemetry(
            changes.addedTools,
          ) as VerifiedNonSensitiveAnalyticsMetadata,
        }
      : {}),
    ...(changes?.removedTools.length
      ? {
          removedTools: sanitizeToolNamesForTelemetry(
            changes.removedTools,
          ) as VerifiedNonSensitiveAnalyticsMetadata,
        }
      : {}),
  })

  logForDebugging(
    `[PROMPT CACHE BREAK] ${key}: ${prevCacheRead} -> ${cacheReadTokens} (-${tokenDrop} tokens); reason=${reason}${diffPath ? ` diff=${diffPath}` : ''}`,
    { level: 'warn' },
  )

  return {
    detected: true,
    reason,
    tokenDrop,
    prevCacheReadTokens: prevCacheRead,
    cacheReadTokens,
    diffPath,
  }
}

/**
 * Suppresses cache-break reporting for the next response after intentional
 * cache deletion (e.g. microcompact cache edit).
 */
export function notifyCacheDeletion(
  querySource: QuerySource | undefined,
  agentId?: string,
): void {
  const key = getTrackingKey(querySource, agentId)
  if (!key) return
  const state = trackedStates.get(key)
  if (state) {
    state.cacheDeletionsPending = true
  }
}

/**
 * Resets baseline `prevCacheReadTokens` after compaction.
 */
export function notifyCompaction(
  querySource: QuerySource | undefined,
  agentId?: string,
): void {
  const key = getTrackingKey(querySource, agentId)
  if (!key) return
  const state = trackedStates.get(key)
  if (state) {
    state.prevCacheReadTokens = null
  }
}

/**
 * Frees prompt-cache tracking state for a finished subagent.
 */
export function cleanupAgentTracking(agentId: AgentId): void {
  trackedStates.delete(agentId)
}

/**
 * Clears all tracked prompt-cache diagnostic states.
 */
export function resetPromptCacheBreakDetection(): void {
  trackedStates.clear()
}
