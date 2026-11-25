import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'events'
import { join } from 'path'
import { z } from 'zod/v4'
import { stripProtoFields } from '../../src/services/analytics/index.js'
import {
  createAbortController,
  createChildAbortController,
} from '../../src/utils/abort_controller.js'
import { count, intersperse, uniq } from '../../src/utils/array.js'
import { createBufferedWriter } from '../../src/utils/buffered_writer.js'
import {
  isInBundledMode,
  isRunningWithBun,
} from '../../src/utils/bundled_mode.js'
import { CircularBuffer } from '../../src/utils/circular_buffer.js'
import { createCombinedAbortSignal } from '../../src/utils/combined_abort_signal.js'
import {
  extractDebugCategories,
  parseDebugFilter,
  shouldShowDebugMessage,
} from '../../src/utils/debug_filter.js'
import {
  getAwsRegion,
  getClaudeConfigHomeDir,
  getDefaultVertexRegion,
  getVertexRegionForModel,
  isEnvDefinedFalsy,
  isEnvTruthy,
  parseEnvVars,
} from '../../src/utils/env_utils.js'
import {
  AbortError,
  classifyAxiosError,
  ClaudeError,
  ConfigParseError,
  errorMessage,
  getErrnoCode,
  getErrnoPath,
  hasExactErrorMessage,
  isAbortError,
  isEnoent,
  isFsInaccessible,
  ShellError,
  shortErrorStack,
  TelemetrySafeError,
  toError,
} from '../../src/utils/errors.js'
import {
  formatDuration,
  formatFileSize,
  formatLogMetadata,
  formatNumber,
  formatRelativeTime,
  formatSecondsShort,
  formatTokens,
} from '../../src/utils/format.js'
import {
  all,
  fromArray,
  lastX,
  returnValue,
  toArray,
} from '../../src/utils/generators.js'
import { djb2Hash, hashContent, hashPair } from '../../src/utils/hash.js'
import {
  firstGrapheme,
  getSystemLocaleLanguage,
  getTimeZone,
  lastGrapheme,
} from '../../src/utils/intl.js'
import { stripBom } from '../../src/utils/json_read.js'
import { lazySchema } from '../../src/utils/lazy_schema.js'
import { objectGroupBy } from '../../src/utils/object_group_by.js'
import { peekForStdinData } from '../../src/utils/process.js'
import {
  formatMs,
  formatTimelineLine,
  getPerformance,
} from '../../src/utils/profiler_base.js'
import { semanticBoolean } from '../../src/utils/semantic_boolean.js'
import { semanticNumber } from '../../src/utils/semantic_number.js'
import * as semver from '../../src/utils/semver.js'
import { sequential } from '../../src/utils/sequential.js'
import { difference, every, intersects, union } from '../../src/utils/set.js'
import { createSignal } from '../../src/utils/signal.js'
import { sleep, withTimeout } from '../../src/utils/sleep.js'
import { Stream } from '../../src/utils/stream.js'
import {
  capitalize,
  countCharInString,
  EndTruncatingAccumulator,
  escapeRegExp,
  firstLineOf,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  plural,
  safeJoinLines,
  truncateToLines,
} from '../../src/utils/string_utils.js'
import {
  registerUpstreamProxyEnvFn,
  subprocessEnv,
} from '../../src/utils/subprocess_env.js'
import { toTaggedId } from '../../src/utils/tagged_id.js'
import { generateTempFilePath } from '../../src/utils/tempfile.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../src/utils/timeouts.js'
import { createAgentId, validateUuid } from '../../src/utils/uuid.js'
import { withResolvers } from '../../src/utils/with_resolvers.js'
import { generateShortWordSlug, generateWordSlug } from '../../src/utils/words.js'
import {
  getWorkload,
  runWithWorkload,
  WORKLOAD_CRON,
} from '../../src/utils/workload_context.js'
import {
  getUserBinDir,
  getXdgCacheHome,
  getXdgDataHome,
  getXdgStateHome,
} from '../../src/utils/xdg.js'
import { escapeXml, escapeXmlAttr } from '../../src/utils/xml.js'
import { parseYaml } from '../../src/utils/yaml.js'
import { zodToJsonSchema } from '../../src/utils/zod_to_json_schema.js'

describe('Step 0.3 — Core data structures & async primitives', () => {
  test('stripProtoFields preserves reference when unchanged and strips _PROTO_* keys', () => {
    const clean = { a: 1, b: true }
    expect(stripProtoFields(clean)).toBe(clean)

    const withProto = { a: 1, _PROTO_user: 'secret', b: 2 }
    const stripped = stripProtoFields(withProto)
    expect(stripped).toEqual({ a: 1, b: 2 })
    expect('_PROTO_user' in stripped).toBe(false)
  })

  test('lazySchema memoizes construction until first call', () => {
    let calls = 0
    const getSchema = lazySchema(() => {
      calls++
      return z.object({ id: z.string() })
    })
    expect(calls).toBe(0)
    const s1 = getSchema()
    const s2 = getSchema()
    expect(calls).toBe(1)
    expect(s1).toBe(s2)
  })

  test('Stream supports enqueue, async iteration, done, and error', async () => {
    const s = new Stream<number>()
    s.enqueue(1)
    s.enqueue(2)
    setTimeout(() => {
      s.enqueue(3)
      s.done()
    }, 5)

    const out: number[] = []
    for await (const n of s) {
      out.push(n)
    }
    expect(out).toEqual([1, 2, 3])
    expect(() => s[Symbol.asyncIterator]()).toThrow()

    const errStream = new Stream<number>()
    errStream.error(new Error('boom'))
    await expect(errStream.next()).rejects.toThrow('boom')
  })

  test('CircularBuffer evicts oldest items and preserves order', () => {
    const buf = new CircularBuffer<number>(3)
    buf.addAll([1, 2, 3, 4, 5])
    expect(buf.length()).toBe(3)
    expect(buf.toArray()).toEqual([3, 4, 5])
    expect(buf.getRecent(2)).toEqual([4, 5])
    buf.clear()
    expect(buf.length()).toBe(0)
    expect(buf.toArray()).toEqual([])
  })

  test('createSignal subscribes, emits, unsubscribes, and clears', () => {
    const sig = createSignal<[string, number]>()
    const received: Array<[string, number]> = []
    const unsub = sig.subscribe((a, b) => received.push([a, b]))
    sig.emit('x', 1)
    unsub()
    sig.emit('y', 2)
    expect(received).toEqual([['x', 1]])
    sig.subscribe(() => received.push(['z', 3]))
    sig.clear()
    sig.emit('w', 4)
    expect(received).toEqual([['x', 1]])
  })

  test('sequential executes concurrent async invocations strictly in order', async () => {
    const order: number[] = []
    const fn = sequential(async (id: number, delayMs: number) => {
      await sleep(delayMs)
      order.push(id)
      return id * 10
    })

    const results = await Promise.all([fn(1, 20), fn(2, 5), fn(3, 1)])
    expect(results).toEqual([10, 20, 30])
    expect(order).toEqual([1, 2, 3])
  })

  test('generators helpers (fromArray, toArray, lastX, returnValue, all)', async () => {
    expect(await toArray(fromArray([1, 2, 3]))).toEqual([1, 2, 3])
    expect(await lastX(fromArray(['a', 'b', 'c']))).toBe('c')
    await expect(lastX(fromArray([]))).rejects.toThrow()

    async function* genWithReturn(): AsyncGenerator<number, string> {
      yield 1
      yield 2
      return 'done'
    }
    expect(await returnValue(genWithReturn())).toBe('done')

    const merged = await toArray(all([fromArray([1, 2]), fromArray([3, 4])], 2))
    expect(merged.sort()).toEqual([1, 2, 3, 4])
  })

  test('withResolvers, sleep, and withTimeout', async () => {
    const { promise, resolve } = withResolvers<string>()
    resolve('ok')
    expect(await promise).toBe('ok')

    const ac = new AbortController()
    const sleeping = sleep(5_000, ac.signal, { throwOnAbort: true })
    ac.abort()
    await expect(sleeping).rejects.toThrow('aborted')

    await expect(
      withTimeout(sleep(5_000), 15, 'timed out!'),
    ).rejects.toThrow('timed out!')
  })

  test('abortController child propagation and combinedAbortSignal', () => {
    const parent = createAbortController()
    const child = createChildAbortController(parent)
    expect(child.signal.aborted).toBe(false)
    parent.abort('stop')
    expect(child.signal.aborted).toBe(true)

    const a = createAbortController()
    const b = createAbortController()
    const { signal, cleanup } = createCombinedAbortSignal(a.signal, {
      signalB: b.signal,
    })
    expect(signal.aborted).toBe(false)
    b.abort()
    expect(signal.aborted).toBe(true)
    cleanup()
  })
})

describe('Step 0.3 — Pure helpers, parsing, formatting & environment utilities', () => {
  test('uuid, taggedId, hash, words', () => {
    const valid = '550e8400-e29b-41d4-a716-446655440000'
    expect(validateUuid(valid)).toBe(valid)
    expect(validateUuid('not-a-uuid')).toBeNull()
    expect(createAgentId('compact')).toMatch(/^acompact-[0-9a-f]{16}$/)

    expect(toTaggedId('user', valid)).toMatch(/^user_01[1-9A-HJ-NP-Za-km-z]{22}$/)
    expect(djb2Hash('abc')).toBe(djb2Hash('abc'))
    expect(hashContent('hello')).toBe(hashContent('hello'))
    expect(hashPair('ts', 'code')).not.toBe(hashPair('tsc', 'ode'))

    expect(generateWordSlug().split('-').length).toBe(3)
    expect(generateShortWordSlug().split('-').length).toBe(2)
  })

  test('array, set, objectGroupBy, stringUtils', () => {
    expect(intersperse(['a', 'b', 'c'], i => String(i))).toEqual([
      'a',
      '1',
      'b',
      '2',
      'c',
    ])
    expect(count([1, 2, 3, 4], x => x % 2 === 0)).toBe(2)
    expect(uniq([1, 2, 2, 3])).toEqual([1, 2, 3])

    const s1 = new Set([1, 2, 3])
    const s2 = new Set([2, 3, 4])
    expect([...difference(s1, s2)]).toEqual([1])
    expect(intersects(s1, s2)).toBe(true)
    expect(every(new Set([2, 3]), s1)).toBe(true)
    expect([...union(s1, s2)]).toEqual([1, 2, 3, 4])

    expect(objectGroupBy(['ant', 'ape', 'bee'], w => w[0]!)).toEqual({
      a: ['ant', 'ape'],
      b: ['bee'],
    })

    expect(escapeRegExp('a.b*c?')).toBe('a\\.b\\*c\\?')
    expect(capitalize('fooBar')).toBe('FooBar')
    expect(plural(1, 'file')).toBe('file')
    expect(plural(2, 'entry', 'entries')).toBe('entries')
    expect(firstLineOf('line1\nline2')).toBe('line1')
    expect(countCharInString('a,b,c,', ',')).toBe(3)
    expect(normalizeFullWidthDigits('１２３')).toBe('123')
    expect(normalizeFullWidthSpace('a\u3000b')).toBe('a b')
    expect(safeJoinLines(['hello', 'world'], ',', 8)).toContain('...[truncated]')
    expect(truncateToLines('1\n2\n3', 2)).toBe('1\n2…')

    const acc = new EndTruncatingAccumulator(5)
    acc.append('abcdef')
    expect(acc.truncated).toBe(true)
    expect(acc.length).toBe(5)
    expect(acc.totalBytes).toBe(6)
    expect(acc.toString()).toContain('output truncated')
  })

  test('format, intl, xml, jsonRead, yaml, semver', () => {
    expect(formatFileSize(512)).toBe('512 bytes')
    expect(formatFileSize(1536)).toBe('1.5KB')
    expect(formatSecondsShort(1234)).toBe('1.2s')
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(3600_000, { hideTrailingZeros: true })).toBe('1h')
    expect(formatNumber(1321)).toBe('1.3k')
    expect(formatTokens(1000)).toBe('1k')
    const now = new Date('2026-01-01T12:00:00Z')
    expect(
      formatRelativeTime(new Date('2026-01-01T11:55:00Z'), { now }),
    ).toBe('5m ago')
    expect(
      formatLogMetadata({ modified: now, messageCount: 4, gitBranch: 'main' }),
    ).toContain('main')

    expect(firstGrapheme('👨‍👩‍👧‍👦abc')).toBe('👨‍👩‍👧‍👦')
    expect(lastGrapheme('abc👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦')
    expect(typeof getTimeZone()).toBe('string')
    expect(getSystemLocaleLanguage()).toBeDefined()

    expect(escapeXml('<a & b>')).toBe('&lt;a &amp; b&gt;')
    expect(escapeXmlAttr(`"x'y"`)).toBe('&quot;x&apos;y&quot;')
    expect(stripBom('\uFEFF{"a":1}')).toBe('{"a":1}')
    expect(parseYaml('name: copilot\nport: 3000')).toEqual({
      name: 'copilot',
      port: 3000,
    })

    expect(semver.gt('2.0.0', '1.9.9')).toBe(true)
    expect(semver.gte('1.0.0', '1.0.0')).toBe(true)
    expect(semver.lt('1.0.0', '1.0.1')).toBe(true)
    expect(semver.lte('1.0.0', '1.0.0')).toBe(true)
    expect(semver.satisfies('1.2.3', '^1.0.0')).toBe(true)
    expect(semver.order('1.0.0', '2.0.0')).toBe(-1)
  })

  test('errors, debugFilter, semanticBoolean/Number, zodToJsonSchema', () => {
    expect(new ClaudeError('x').name).toBe('ClaudeError')
    expect(new TelemetrySafeError('detail', 'safe').telemetryMessage).toBe(
      'safe',
    )
    expect(isAbortError(new AbortError())).toBe(true)
    expect(new ConfigParseError('bad', '/a.json', {}).filePath).toBe('/a.json')
    expect(new ShellError('o', 'e', 2, false).code).toBe(2)
    expect(hasExactErrorMessage(new Error('abc'), 'abc')).toBe(true)
    expect(toError('str').message).toBe('str')
    expect(errorMessage('str')).toBe('str')
    const enoent = Object.assign(new Error('missing'), {
      code: 'ENOENT',
      path: '/nope',
    })
    expect(getErrnoCode(enoent)).toBe('ENOENT')
    expect(isEnoent(enoent)).toBe(true)
    expect(getErrnoPath(enoent)).toBe('/nope')
    expect(isFsInaccessible(enoent)).toBe(true)
    expect(shortErrorStack(new Error('stack'), 2)).toContain('stack')
    expect(
      classifyAxiosError({
        isAxiosError: true,
        response: { status: 403 },
        message: 'Forbidden',
      }).kind,
    ).toBe('auth')

    const inc = parseDebugFilter('api,hooks')
    expect(extractDebugCategories('api: request')).toEqual(['api'])
    expect(shouldShowDebugMessage('api: request', inc)).toBe(true)
    expect(shouldShowDebugMessage('file: read', inc)).toBe(false)

    expect(semanticBoolean().parse('true')).toBe(true)
    expect(semanticBoolean().parse('false')).toBe(false)
    expect(semanticNumber().parse('42.5')).toBe(42.5)
    expect(() => semanticNumber().parse('')).toThrow()

    const schema = z.object({ name: z.string(), count: z.number() })
    const js1 = zodToJsonSchema(schema)
    const js2 = zodToJsonSchema(schema)
    expect(js1).toBe(js2)
    expect(js1.type).toBe('object')
  })

  test('XDG, tempfile, bufferedWriter, envUtils, subprocessEnv, process, profilerBase, workloadContext', async () => {
    expect(isRunningWithBun()).toBe(true)
    expect(typeof isInBundledMode()).toBe('boolean')

    const xdgOpts = { env: { XDG_CACHE_HOME: '/custom/cache' }, homedir: '/h' }
    expect(getXdgCacheHome(xdgOpts)).toBe('/custom/cache')
    expect(getXdgStateHome({ env: {}, homedir: '/h' })).toBe(
      join('/h', '.local', 'state'),
    )
    expect(getXdgDataHome({ env: {}, homedir: '/h' })).toBe(
      join('/h', '.local', 'share'),
    )
    expect(getUserBinDir({ homedir: '/h' })).toBe(join('/h', '.local', 'bin'))

    const p1 = generateTempFilePath('test', '.txt', { contentHash: 'same' })
    const p2 = generateTempFilePath('test', '.txt', { contentHash: 'same' })
    expect(p1).toBe(p2)

    const chunks: string[] = []
    const bw = createBufferedWriter({
      writeFn: s => chunks.push(s),
      flushIntervalMs: 5000,
    })
    bw.write('a')
    bw.write('b')
    expect(chunks).toEqual([])
    bw.flush()
    expect(chunks).toEqual(['ab'])
    bw.dispose()

    expect(isEnvTruthy('YES')).toBe(true)
    expect(isEnvDefinedFalsy('0')).toBe(true)
    expect(parseEnvVars(['FOO=bar=baz'])).toEqual({ FOO: 'bar=baz' })
    expect(typeof getClaudeConfigHomeDir()).toBe('string')
    expect(typeof getAwsRegion()).toBe('string')
    expect(typeof getDefaultVertexRegion()).toBe('string')
    expect(typeof getVertexRegionForModel('claude-sonnet-4-6')).toBe('string')
    expect(getDefaultBashTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '5000' })).toBe(
      5000,
    )
    expect(
      getMaxBashTimeoutMs({
        BASH_DEFAULT_TIMEOUT_MS: '800000',
        BASH_MAX_TIMEOUT_MS: '1000',
      }),
    ).toBe(800000)

    const prevScrub = process.env.COPILOT_CLI_SUBPROCESS_ENV_SCRUB
    const prevKey = process.env.ANTHROPIC_API_KEY
    try {
      process.env.COPILOT_CLI_SUBPROCESS_ENV_SCRUB = '1'
      process.env.ANTHROPIC_API_KEY = 'sk-secret'
      registerUpstreamProxyEnvFn(() => ({ HTTPS_PROXY: 'http://127.0.0.1:8080' }))
      const sub = subprocessEnv()
      expect(sub.ANTHROPIC_API_KEY).toBeUndefined()
      expect(sub.HTTPS_PROXY).toBe('http://127.0.0.1:8080')
    } finally {
      if (prevScrub === undefined)
        delete process.env.COPILOT_CLI_SUBPROCESS_ENV_SCRUB
      else process.env.COPILOT_CLI_SUBPROCESS_ENV_SCRUB = prevScrub
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevKey
      registerUpstreamProxyEnvFn(() => ({}))
    }

    const fakeStdin = new EventEmitter()
    const peekPromise = peekForStdinData(fakeStdin, 50)
    fakeStdin.emit('end')
    expect(await peekPromise).toBe(false)

    expect(typeof getPerformance().now()).toBe('number')
    expect(formatMs(12.3456)).toBe('12.346')
    expect(formatTimelineLine(10, 2, 'init', undefined, 8, 7)).toContain('init')

    expect(getWorkload()).toBeUndefined()
    const wl = runWithWorkload(WORKLOAD_CRON, () => {
      expect(getWorkload()).toBe('cron')
      return runWithWorkload(undefined, () => getWorkload())
    })
    expect(wl).toBeUndefined()
  })
})
