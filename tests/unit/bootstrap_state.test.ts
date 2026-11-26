import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  addInvokedSkill,
  addToInMemoryErrorLog,
  addToTotalCostState,
  clearBetaHeaderLatches,
  clearInvokedSkills,
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getInMemoryBootstrapErrorLog,
  getInvokedSkills,
  getParentSessionId,
  getSessionId,
  getSessionProjectDir,
  getThinkingClearLatched,
  getTotalCostUsd,
  getTotalInputTokens,
  onSessionSwitch,
  regenerateSessionId,
  resetStateForTests,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setIsInteractive,
  setThinkingClearLatched,
  switchSession,
} from '../../src/bootstrap/state.js'
import {
  clearGrowthBookConfigOverrides,
  getFeatureValueCachedMayBeStale,
  onGrowthBookRefresh,
  resetGrowthBook,
  setGrowthBookConfigOverride,
} from '../../src/services/analytics/growthbook.js'
import { asSessionId } from '../../src/types/ids.js'
import { ActivityManager } from '../../src/utilities/activity_manager.js'
import { getCwd, runWithCwdOverride } from '../../src/utilities/cwd.js'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from '../../src/utilities/frontmatter_parser.js'
import { parseJsonl, safeParseJson } from '../../src/utilities/json.js'
import {
  getInMemoryErrors,
  logError,
  resetErrorLogForTesting,
} from '../../src/utilities/log.js'
import { memoizeWithLru, memoizeWithTtl } from '../../src/utilities/memoize.js'
import {
  containsPathTraversal,
  normalizePathForConfigKey,
  sanitizePath,
} from '../../src/utilities/path.js'
import {
  drainSdkEvents,
  emitTaskTerminatedSdk,
  enqueueSdkEvent,
} from '../../src/utilities/sdk_event_queue.js'
import {
  posixPathToWindowsPath,
  windowsPathToPosixPath,
} from '../../src/utilities/windows_paths.js'

afterEach(() => {
  resetStateForTests()
  resetErrorLogForTesting()
  resetGrowthBook()
})

describe('bootstrap/state isolation and semantics', () => {
  test('bootstrap/state.ts contains zero React or Ink imports', () => {
    const stateFile = join(process.cwd(), 'src', 'bootstrap', 'state.ts')
    const source = readFileSync(stateFile, 'utf8')
    expect(source).not.toMatch(/from\s+['"]react['"/]/)
    expect(source).not.toMatch(/from\s+['"]ink['"/]/)
    expect(source).not.toMatch(/from\s+['"]\.\.\/ink\//)
  })

  test('switchSession, regenerateSessionId, and onSessionSwitch stay atomic', () => {
    const initialId = getSessionId()
    const switched: string[] = []
    const unsubscribe = onSessionSwitch(sessionId => {
      switched.push(sessionId)
    })

    const targetId = asSessionId('11111111-2222-4333-8444-555555555555')
    switchSession(targetId, '/tmp/worktree-project')
    expect<string>(getSessionId()).toBe(targetId)
    expect(getSessionProjectDir()).toBe('/tmp/worktree-project')
    expect(switched).toEqual([targetId])

    unsubscribe()

    const regenerated = regenerateSessionId({ setCurrentAsParent: true })
    expect<string>(regenerated).not.toBe(targetId)
    expect<string>(regenerated).not.toBe(initialId)
    expect<string | undefined>(getParentSessionId()).toBe(targetId)
    expect(getSessionProjectDir()).toBeNull()
  })

  test('4 sticky Beta header latches latch and clear atomically', () => {
    expect(getAfkModeHeaderLatched()).toBeNull()
    expect(getFastModeHeaderLatched()).toBeNull()
    expect(getCacheEditingHeaderLatched()).toBeNull()
    expect(getThinkingClearLatched()).toBeNull()

    setAfkModeHeaderLatched(true)
    setFastModeHeaderLatched(true)
    setCacheEditingHeaderLatched(true)
    setThinkingClearLatched(true)

    expect(getAfkModeHeaderLatched()).toBe(true)
    expect(getFastModeHeaderLatched()).toBe(true)
    expect(getCacheEditingHeaderLatched()).toBe(true)
    expect(getThinkingClearLatched()).toBe(true)

    clearBetaHeaderLatches()
    expect(getAfkModeHeaderLatched()).toBeNull()
    expect(getFastModeHeaderLatched()).toBeNull()
    expect(getCacheEditingHeaderLatched()).toBeNull()
    expect(getThinkingClearLatched()).toBeNull()
  })

  test('in-memory error ring buffer enforces 100-entry cap', () => {
    for (let i = 0; i < 120; i++) {
      addToInMemoryErrorLog({
        error: `bootstrap-err-${i}`,
        timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      })
      logError(new Error(`log-err-${i}`))
    }

    const bootstrapErrors = getInMemoryBootstrapErrorLog()
    expect(bootstrapErrors.length).toBe(100)
    expect(bootstrapErrors[0]!.error).toBe('bootstrap-err-20')
    expect(bootstrapErrors[99]!.error).toBe('bootstrap-err-119')

    const logErrors = getInMemoryErrors()
    expect(logErrors.length).toBe(100)
    expect(logErrors[0]!.error).toContain('log-err-20')
    expect(logErrors[99]!.error).toContain('log-err-119')
  })

  test('cost accumulators and invoked skills track and reset cleanly', () => {
    addToTotalCostState(
      0.42,
      {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadInputTokens: 500,
        cacheCreationInputTokens: 100,
        webSearchRequests: 1,
        costUsd: 0.42,
        contextWindow: 200_000,
        maxOutputTokens: 8192,
      },
      'claude-sonnet-4-6',
    )
    expect(getTotalCostUsd()).toBeCloseTo(0.42)
    expect(getTotalInputTokens()).toBe(1000)

    addInvokedSkill('commit', '/skills/commit.md', 'content', 'agent-1')
    expect(getInvokedSkills().size).toBe(1)
    clearInvokedSkills()
    expect(getInvokedSkills().size).toBe(0)
  })
})

describe('Step 1.1 runtime utilities', () => {
  test('runWithCwdOverride scopes CWD per async context', async () => {
    const baseCwd = getCwd()
    const observed = await runWithCwdOverride('/virtual/workspace', async () => {
      await Promise.resolve()
      return getCwd()
    })
    expect(observed).toBe('/virtual/workspace')
    expect(getCwd()).toBe(baseCwd)
  })

  test('frontmatter parser handles YAML and brace globs', () => {
    const parsed = parseFrontmatter(
      '---\ndescription: Deploy helper\npaths: src/*.{ts,tsx}\n---\nBody text',
    )
    expect(parsed.frontmatter.description).toBe('Deploy helper')
    expect(parsed.content).toBe('Body text')
    expect(splitPathInFrontmatter('a, src/*.{ts,tsx}')).toEqual([
      'a',
      'src/*.ts',
      'src/*.tsx',
    ])
  })

  test('JSON and JSONL parsers strip BOM and skip malformed lines', () => {
    expect(safeParseJson('\uFEFF{"ok":true}')).toEqual({ ok: true })
    expect(safeParseJson('invalid-json', false)).toBeNull()

    const records = parseJsonl<{ id: number }>(
      '\uFEFF{"id":1}\nnot-json\n{"id":2}\n',
    )
    expect(records).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('memoizeWithLru evicts oldest keys and memoizeWithTtl caches results', () => {
    let calls = 0
    const fn = memoizeWithLru(
      (key: string) => {
        calls++
        return `val:${key}`
      },
      key => key,
      2,
    )
    expect(fn('a')).toBe('val:a')
    expect(fn('b')).toBe('val:b')
    expect(fn('a')).toBe('val:a')
    expect(calls).toBe(2)
    expect(fn('c')).toBe('val:c')
    expect(fn.cache.size()).toBe(2)
    expect(fn.cache.has('b')).toBe(false)

    let ttlCalls = 0
    const ttlFn = memoizeWithTtl((value: number) => {
      ttlCalls++
      return value * 2
    }, 10_000)
    expect(ttlFn(3)).toBe(6)
    expect(ttlFn(3)).toBe(6)
    expect(ttlCalls).toBe(1)
  })

  test('path helpers handle Windows/POSIX conversion and traversal detection', () => {
    expect(windowsPathToPosixPath('C:\\Users\\alice\\repo')).toBe(
      '/c/Users/alice/repo',
    )
    expect(posixPathToWindowsPath('/c/Users/alice/repo')).toBe(
      'C:\\Users\\alice\\repo',
    )
    expect(containsPathTraversal('../secret.txt')).toBe(true)
    expect(containsPathTraversal('src/index.ts')).toBe(false)
    expect(normalizePathForConfigKey('C:\\Users\\alice\\repo')).toBe(
      'C:/Users/alice/repo',
    )
    expect(sanitizePath('/Users/alice/my:repo')).toBe('-Users-alice-my-repo')
  })

  test('sdk_event_queue buffers only in non-interactive mode and drains with session_id', () => {
    setIsInteractive(true)
    enqueueSdkEvent({
      type: 'system',
      subtype: 'session_state_changed',
      state: 'running',
    })
    expect(drainSdkEvents()).toEqual([])

    setIsInteractive(false)
    emitTaskTerminatedSdk('task-1', 'completed', { summary: 'Done' })
    const drained = drainSdkEvents()
    expect(drained.length).toBe(1)
    expect(drained[0]!.subtype).toBe('task_notification')
    expect<string>(drained[0]!.session_id).toBe(getSessionId())
    expect(drainSdkEvents()).toEqual([])
  })

  test('ActivityManager records CLI and user active intervals', () => {
    let now = 1000
    const recorded: Array<{ value: number; type: string }> = []
    const manager = ActivityManager.createInstance({
      getNow: () => now,
      getActiveTimeCounter: () => ({
        add(value, attrs) {
          recorded.push({ value, type: String(attrs?.type ?? '') })
        },
      }),
    })

    manager.recordUserActivity()
    now = 3000
    manager.recordUserActivity()
    manager.startCliActivity('op-1')
    now = 5500
    manager.endCliActivity('op-1')

    expect(recorded).toEqual([
      { value: 2, type: 'user' },
      { value: 2.5, type: 'cli' },
    ])
    ActivityManager.resetInstance()
  })

  test('growthbook local facade returns defaults and notifies refresh listeners on override', () => {
    expect(getFeatureValueCachedMayBeStale('some_flag', false)).toBe(false)
    let notifications = 0
    const unsubscribe = onGrowthBookRefresh(() => {
      notifications++
    })

    setGrowthBookConfigOverride('some_flag', true)
    expect(getFeatureValueCachedMayBeStale('some_flag', false)).toBe(true)
    expect(notifications).toBe(1)

    clearGrowthBookConfigOverrides()
    expect(getFeatureValueCachedMayBeStale('some_flag', false)).toBe(false)
    unsubscribe()
  })
})
