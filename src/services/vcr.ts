/**
 * Deterministic VCR (record/replay) harness for LLM and token-count regression tests.
 */

import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { addToTotalSessionCost } from '../cost_tracker.js'
import type { AssistantMessage, Message, StreamEvent, SystemApiErrorMessage } from '../types/message.js'
import { randomUUID } from '../utilities/crypto.js'
import { getCwd } from '../utilities/cwd.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../utilities/env_utils.js'
import { getFsImplementation } from '../utilities/fs_operations.js'
import { calculateUsdCost } from '../utilities/model_cost.js'
import { jsonParse, jsonStringify } from '../utilities/slow_operations.js'

interface VcrFixture {
  input: unknown
  output: unknown[]
}

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIMESTAMP_REGEX =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

/**
 * Returns true if VCR recording/replaying is active for the current run.
 */
export function isVcrEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    (isEnvTruthy(process.env.VCR_ENABLED) ||
      isEnvTruthy(process.env.VCR_RECORD) ||
      (process.env.USER_TYPE === 'ant' && isEnvTruthy(process.env.FORCE_VCR)))
  )
}

function getFixturesDir(): string {
  const root = process.env.COPILOT_CLI_TEST_FIXTURES_ROOT || getCwd()
  return join(root, 'fixtures')
}

function dehydrateString(text: string): string {
  const cwd = getCwd()
  const configHome = getClaudeConfigHomeDir()
  let result = text
  if (cwd) {
    result = result.replaceAll(cwd, '[CWD]')
    const cwdSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    result = result.replaceAll(cwdSlug, '[CWD_SLUG]')
  }
  if (configHome) {
    result = result.replaceAll(configHome, '[CONFIG_HOME]')
  }
  result = result.replace(UUID_REGEX, '[UUID]')
  result = result.replace(ISO_TIMESTAMP_REGEX, '[TIMESTAMP]')
  result = result.replace(/\b\d+ms\b/g, '[DURATION]')
  return result
}

function hydrateString(text: string): string {
  return text
    .replaceAll('[CWD]', getCwd())
    .replaceAll('[CONFIG_HOME]', getClaudeConfigHomeDir())
    .replaceAll('[NUM]', '1')
    .replaceAll('[DURATION]', '0ms')
}

/**
 * Recursively replaces environment-specific paths, UUIDs, and timestamps with
 * deterministic tokens for stable VCR fixture hashing.
 */
export function dehydrateValue<Value>(value: Value): Value {
  if (typeof value === 'string') {
    return dehydrateString(value) as Value
  }
  if (Array.isArray(value)) {
    return value.map(item => dehydrateValue(item)) as Value
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === 'uuid' || key === 'timestamp' || key === 'requestId') {
        continue
      }
      result[key] = dehydrateValue(entry)
    }
    return result as Value
  }
  return value
}

/**
 * Restores hydrated paths and generates fresh UUIDs for replayed VCR messages.
 */
export function hydrateValue<Value>(value: Value): Value {
  if (typeof value === 'string') {
    return hydrateString(value) as Value
  }
  if (Array.isArray(value)) {
    return value.map(item => hydrateValue(item)) as Value
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(record)) {
      result[key] = hydrateValue(entry)
    }
    if (
      typeof record.type === 'string' &&
      (record.type === 'assistant' ||
        record.type === 'user' ||
        record.type === 'system' ||
        record.type === 'attachment')
    ) {
      result.uuid = randomUUID()
      result.timestamp = new Date().toISOString()
    }
    return result as Value
  }
  return value
}

/**
 * Computes a deterministic multi-segment SHA-1 fixture key from dehydrated messages.
 */
export function computeVcrHash(messages: readonly Message[]): string {
  const segments = messages.map(message => {
    const serialized = jsonStringify(dehydrateValue(message))
    return createHash('sha1').update(serialized).digest('hex').slice(0, 6)
  })
  if (segments.length === 0) {
    return 'empty'
  }
  return segments.join('-')
}

function readFixture<FixtureType>(fixturePath: string): FixtureType | null {
  try {
    const raw = getFsImplementation().readFileSync(fixturePath, {
      encoding: 'utf-8',
    })
    return jsonParse(raw) as FixtureType
  } catch {
    return null
  }
}

function writeFixture(fixturePath: string, data: unknown): void {
  mkdirSync(dirname(fixturePath), { recursive: true })
  writeFileSync(fixturePath, jsonStringify(data, null, 2), {
    encoding: 'utf-8',
  })
}

function accountReplayedAssistantCosts(items: readonly unknown[]): void {
  for (const item of items) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'assistant'
    ) {
      const assistantMsg = item as AssistantMessage
      const model = assistantMsg.message?.model
      const usage = assistantMsg.message?.usage
      if (model && usage && model !== '<synthetic>') {
        const cost = calculateUsdCost(model, usage)
        addToTotalSessionCost(cost, usage, model)
      }
    }
  }
}

/**
 * Wraps an asynchronous LLM call returning an array of messages/events with
 * VCR replay & recording.
 */
export async function withVcr<Item>(
  messages: readonly Message[],
  fn: () => Promise<Item[]>,
): Promise<Item[]> {
  if (!isVcrEnabled()) {
    return fn()
  }

  const hash = computeVcrHash(messages)
  const fixturePath = join(getFixturesDir(), `${hash}.json`)
  const recordMode = isEnvTruthy(process.env.VCR_RECORD)

  if (!recordMode) {
    const existing = readFixture<VcrFixture>(fixturePath)
    if (existing) {
      const hydrated = hydrateValue(existing.output) as Item[]
      accountReplayedAssistantCosts(hydrated)
      return hydrated
    }
    if (isEnvTruthy(process.env.CI)) {
      throw new Error(
        `Missing VCR fixture at ${fixturePath} in CI mode. Run with VCR_RECORD=1 locally to record it.`,
      )
    }
  }

  const output = await fn()
  writeFixture(fixturePath, {
    input: dehydrateValue(messages),
    output: dehydrateValue(output),
  } satisfies VcrFixture)
  return output
}

/**
 * Wraps a streaming `queryModelWithStreaming`-style async generator in VCR replay/recording.
 */
export async function* withStreamingVcr<
  Item = StreamEvent | AssistantMessage | SystemApiErrorMessage,
>(
  messages: readonly Message[],
  genFn: () => AsyncGenerator<Item, void>,
): AsyncGenerator<Item, void> {
  if (!isVcrEnabled()) {
    yield* genFn()
    return
  }

  const results = await withVcr(messages, async () => {
    const collected: Item[] = []
    for await (const item of genFn()) {
      collected.push(item)
    }
    return collected
  })
  for (const item of results) {
    yield item
  }
}

/**
 * Wraps token-count API calls in deterministic VCR fixture caching (`token-count-<hash>.json`).
 */
export async function withTokenCountVcr(
  messages: readonly unknown[],
  tools: readonly unknown[],
  fn: () => Promise<number | null>,
): Promise<number | null> {
  if (!isVcrEnabled()) {
    return fn()
  }

  const payload = dehydrateValue({ messages, tools })
  const hash = createHash('sha1')
    .update(jsonStringify(payload))
    .digest('hex')
    .slice(0, 12)
  const fixturePath = join(getFixturesDir(), `token-count-${hash}.json`)
  const recordMode = isEnvTruthy(process.env.VCR_RECORD)

  if (!recordMode) {
    const existing = readFixture<{ tokenCount: number | null }>(fixturePath)
    if (existing !== null) {
      return existing.tokenCount
    }
    if (isEnvTruthy(process.env.CI)) {
      throw new Error(
        `Missing token-count VCR fixture at ${fixturePath} in CI mode.`,
      )
    }
  }

  const tokenCount = await fn()
  writeFixture(fixturePath, { tokenCount })
  return tokenCount
}
