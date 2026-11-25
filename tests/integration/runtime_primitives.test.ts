import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  attachAnalyticsSink,
  logEvent,
  logEventAsync,
  resetForTesting,
} from '../../src/services/analytics/index.js'
import { createBufferedWriter } from '../../src/utils/buffered_writer.js'
import {
  registerCleanup,
  runCleanupFunctions,
} from '../../src/utils/cleanup_registry.js'
import * as lockfile from '../../src/utils/lockfile.js'
import { generateTempFilePath } from '../../src/utils/tempfile.js'

describe('Phase 0 integration — filesystem, lifecycle & analytics sink plumbing', () => {
  afterEach(() => {
    resetForTesting()
  })

  test('lockfile acquires, detects, and releases a lock on a real file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-lock-'))
    try {
      const target = join(dir, 'state.json')
      writeFileSync(target, '{}')
      const release = await lockfile.lock(target)
      expect(await lockfile.check(target)).toBe(true)
      await release()
      expect(await lockfile.check(target)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('bufferedWriter flushes batches to disk on cleanupRegistry shutdown', async () => {
    const logPath = generateTempFilePath('copilot-int-log', '.log')
    const writer = createBufferedWriter({
      writeFn: chunk => appendFileSync(logPath, chunk),
      flushIntervalMs: 60_000,
    })
    const unregister = registerCleanup(async () => {
      writer.dispose()
    })

    try {
      writer.write('line-1\n')
      writer.write('line-2\n')
      await runCleanupFunctions()
      expect(readFileSync(logPath, 'utf8')).toBe('line-1\nline-2\n')
    } finally {
      unregister()
      rmSync(logPath, { force: true })
    }
  })

  test('analytics facade buffers pre-init events and drains asynchronously on sink attach', async () => {
    const syncEvents: Array<{ name: string; meta: Record<string, unknown> }> = []
    const asyncEvents: Array<{ name: string; meta: Record<string, unknown> }> =
      []

    logEvent('early_sync', { count: 1 })
    await logEventAsync('early_async', { ok: true })

    attachAnalyticsSink({
      logEvent(eventName, metadata) {
        syncEvents.push({ name: eventName, meta: metadata })
      },
      async logEventAsync(eventName, metadata) {
        asyncEvents.push({ name: eventName, meta: metadata })
      },
    })

    // Idempotent second attach should be ignored
    attachAnalyticsSink({
      logEvent() {
        throw new Error('Should not replace sink')
      },
      async logEventAsync() {
        throw new Error('Should not replace sink')
      },
    })

    await Promise.resolve()
    expect(syncEvents).toEqual([{ name: 'early_sync', meta: { count: 1 } }])
    expect(asyncEvents).toEqual([{ name: 'early_async', meta: { ok: true } }])

    logEvent('direct_event', { count: 2 })
    expect(syncEvents.length).toBe(2)
  })

  test('cleanupRegistry executes remaining handlers and respects unregistration', async () => {
    let ran = 0
    const unreg1 = registerCleanup(async () => {
      ran += 1
    })
    const unreg2 = registerCleanup(async () => {
      ran += 10
    })
    unreg2()
    await runCleanupFunctions()
    unreg1()
    expect(ran).toBe(1)
  })
})
