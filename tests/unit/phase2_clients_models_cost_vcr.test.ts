import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getSessionId,
  resetCostState,
  resetStateForTests,
} from '../../src/bootstrap/state.js'
import {
  addToTotalSessionCost,
  formatTotalCost,
  getStoredSessionCosts,
  getTotalCost,
  saveCurrentSessionCosts,
} from '../../src/cost_tracker.js'
import {
  CLIENT_REQUEST_ID_HEADER,
  getAnthropicClient,
  parseCustomHeaders,
} from '../../src/services/api/client.js'
import { EMPTY_USAGE } from '../../src/services/api/empty_usage.js'
import {
  bytesPerTokenForFileType,
  roughTokenCountEstimation,
  roughTokenCountEstimationForFileType,
} from '../../src/services/token_estimation.js'
import {
  computeVcrHash,
  dehydrateValue,
  hydrateValue,
  withStreamingVcr,
  withVcr,
} from '../../src/services/vcr.js'
import type { AssistantMessage } from '../../src/types/message.js'
import {
  getModelBetas,
  shouldUseGlobalCacheScope,
} from '../../src/utilities/betas.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  has1mContext,
} from '../../src/utilities/context.js'
import {
  parseEffortValue,
  resolveAppliedEffort,
} from '../../src/utilities/effort.js'
import {
  isFastModeCooldown,
  resetFastModeStateForTesting,
  triggerFastModeCooldown,
} from '../../src/utilities/fast_mode.js'
import { createUserMessage } from '../../src/utilities/messages.js'
import {
  applyBedrockRegionPrefix,
  getBedrockRegionPrefix,
  isFoundationModel,
} from '../../src/utilities/model/bedrock.js'
import {
  firstPartyNameToCanonical,
  getRuntimeMainLoopModel,
  normalizeModelStringForApi,
  parseUserSpecifiedModel,
} from '../../src/utilities/model/model.js'
import { isModelAllowed } from '../../src/utilities/model/model_allowlist.js'
import { getApiProvider } from '../../src/utilities/model/providers.js'
import { calculateUsdCost } from '../../src/utilities/model_cost.js'
import {
  clearOptionalModuleOverridesForTesting,
  registerOptionalModuleForTesting,
} from '../../src/utilities/optional_import.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import {
  hasUltrathinkKeyword,
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../../src/utilities/thinking.js'

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'COPILOT_CLI_USE_BEDROCK',
  'COPILOT_CLI_USE_VERTEX',
  'COPILOT_CLI_USE_FOUNDRY',
  'AWS_REGION',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'VCR_ENABLED',
  'VCR_RECORD',
  'COPILOT_CLI_TEST_FIXTURES_ROOT',
  'NODE_ENV',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tempDir = ''

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tempDir = mkdtempSync(join(tmpdir(), 'copilot-phase2-clients-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  process.env.NODE_ENV = 'test'
  resetStateForTests()
  resetCostState()
  resetSettingsCache()
  resetFastModeStateForTesting()
  clearOptionalModuleOverridesForTesting()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
  resetStateForTests()
  resetCostState()
  resetSettingsCache()
  resetFastModeStateForTesting()
  clearOptionalModuleOverridesForTesting()
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('Step 2.2 — Multi-Provider Clients, Models, Pricing, and VCR', () => {
  test('constructs 1P, Bedrock, Vertex, and Foundry clients via factory and parses custom headers', async () => {
    expect(
      parseCustomHeaders('X-Custom-A: alpha\nX-Custom-B: beta:gamma\n'),
    ).toEqual({
      'X-Custom-A': 'alpha',
      'X-Custom-B': 'beta:gamma',
    })

    // 1P client
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant: acme'
    expect(getApiProvider()).toBe('firstParty')
    const client1p = await getAnthropicClient({ model: 'claude-sonnet-4-6' })
    expect(client1p).toBeDefined()
    expect(CLIENT_REQUEST_ID_HEADER).toBe('x-client-request-id')

    // Bedrock client via optional module override
    let capturedBedrockOpts: Record<string, unknown> | undefined
    registerOptionalModuleForTesting('@anthropic-ai/bedrock-sdk', {
      AnthropicBedrock: class MockBedrock {
        constructor(opts: Record<string, unknown>) {
          capturedBedrockOpts = opts
        }
      },
    })
    process.env.COPILOT_CLI_USE_BEDROCK = '1'
    process.env.AWS_REGION = 'us-west-2'
    expect(getApiProvider()).toBe('bedrock')
    await getAnthropicClient({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' })
    expect(capturedBedrockOpts?.awsRegion).toBe('us-west-2')
    delete process.env.COPILOT_CLI_USE_BEDROCK

    // Vertex client via optional module override
    let capturedVertexOpts: Record<string, unknown> | undefined
    registerOptionalModuleForTesting('@anthropic-ai/vertex-sdk', {
      AnthropicVertex: class MockVertex {
        constructor(opts: Record<string, unknown>) {
          capturedVertexOpts = opts
        }
      },
    })
    process.env.COPILOT_CLI_USE_VERTEX = '1'
    process.env.CLOUD_ML_REGION = 'us-east5'
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'my-gcp-project'
    expect(getApiProvider()).toBe('vertex')
    await getAnthropicClient({ model: 'claude-sonnet-4-5@20250929' })
    expect(capturedVertexOpts?.region).toBe('us-east5')
    expect(capturedVertexOpts?.projectId).toBe('my-gcp-project')
    delete process.env.COPILOT_CLI_USE_VERTEX

    // Foundry client via optional module override
    let capturedFoundryOpts: Record<string, unknown> | undefined
    registerOptionalModuleForTesting('@anthropic-ai/foundry-sdk', {
      AnthropicFoundry: class MockFoundry {
        constructor(opts: Record<string, unknown>) {
          capturedFoundryOpts = opts
        }
      },
    })
    process.env.COPILOT_CLI_USE_FOUNDRY = '1'
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'my-foundry-res'
    process.env.ANTHROPIC_FOUNDRY_API_KEY = 'azure-key-123'
    expect(getApiProvider()).toBe('foundry')
    await getAnthropicClient({ model: 'claude-sonnet-4-5' })
    expect(capturedFoundryOpts?.resource).toBe('my-foundry-res')
    expect(capturedFoundryOpts?.apiKey).toBe('azure-key-123')
  })

  test('resolves model aliases, [1m] context suffix, opusplan switching, allowlist, and Bedrock prefixes', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-6[1m]')).toBe(
      'claude-opus-4-6',
    )
    expect(firstPartyNameToCanonical('claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    )
    expect(normalizeModelStringForApi('claude-sonnet-4-6[1m]')).toBe(
      'claude-sonnet-4-6',
    )
    expect(has1mContext('sonnet[1m]')).toBe(true)
    expect(getContextWindowForModel('claude-sonnet-4-6[1m]', [])).toBe(
      1_000_000,
    )
    expect(getContextWindowForModel('claude-sonnet-4-6', [])).toBe(200_000)
    expect(getModelMaxOutputTokens('claude-opus-4-6')).toEqual({
      default: 64_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokens('claude-sonnet-4-6')).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    expect(getModelMaxOutputTokens('claude-sonnet-4-5')).toEqual({
      default: 32_000,
      upperLimit: 64_000,
    })

    expect(parseUserSpecifiedModel('sonnet')).toBe('claude-sonnet-4-6')
    expect(parseUserSpecifiedModel('opus[1m]')).toBe('claude-opus-4-6[1m]')
    expect(parseUserSpecifiedModel('haiku')).toBe('claude-haiku-4-5-20251001')

    // opusplan selects Opus in plan mode and Sonnet otherwise
    const planModel = getRuntimeMainLoopModel({
      permissionMode: 'plan',
      mainLoopModel: 'opusplan',
    })
    const defaultModel = getRuntimeMainLoopModel({
      permissionMode: 'default',
      mainLoopModel: 'opusplan',
    })
    expect(planModel).toContain('opus')
    expect(defaultModel).toContain('sonnet')

    expect(isModelAllowed('claude-sonnet-4-6')).toBe(true)
    expect(getBedrockRegionPrefix('eu.anthropic.claude-sonnet-4-6')).toBe(
      'eu',
    )
    expect(
      applyBedrockRegionPrefix('us.anthropic.claude-haiku-4-5', 'eu'),
    ).toBe('eu.anthropic.claude-haiku-4-5')
    expect(isFoundationModel('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(
      true,
    )
  })

  test('thinking, effort, fast mode cooldown, betas, and token estimation work accurately', () => {
    expect(modelSupportsThinking('claude-opus-4-6')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-opus-4-6')).toBe(true)
    expect(modelSupportsAdaptiveThinking('claude-haiku-4-5-20251001')).toBe(
      false,
    )
    expect(hasUltrathinkKeyword('Please ultrathink about this architecture')).toBe(
      true,
    )
    expect(parseEffortValue('HIGH')).toBe('high')
    expect(parseEffortValue('invalid')).toBeUndefined()
    expect(resolveAppliedEffort('claude-opus-4-6', 'high')).toBe('high')

    expect(isFastModeCooldown()).toBe(false)
    triggerFastModeCooldown(Date.now() + 60_000, 'rate_limit')
    expect(isFastModeCooldown()).toBe(true)

    expect(shouldUseGlobalCacheScope()).toBe(true)
    expect(getModelBetas('claude-sonnet-4-6[1m]')).toContain(
      'context-1m-2025-08-07',
    )

    expect(bytesPerTokenForFileType('.json')).toBe(2)
    expect(bytesPerTokenForFileType('.ts')).toBe(4)
    expect(roughTokenCountEstimation('12345678')).toBe(2)
    expect(roughTokenCountEstimationForFileType('{"a":12}', '.json')).toBe(4)
  })

  test('calculates per-model USD costs (including Opus 4.6 fast mode) and persists session costs', () => {
    // Sonnet 4.6: $3/M input, $15/M output, $3.75/M cache write, $0.30/M cache read, $0.01/search
    const sonnetCost = calculateUsdCost('claude-sonnet-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      server_tool_use: { web_search_requests: 2 },
    })
    expect(sonnetCost).toBeCloseTo(3 + 1.5 + 3.75 + 0.3 + 0.02, 6)

    // Opus 4.6 standard ($5/$25) vs fast mode ($30/$150)
    const opusStd = calculateUsdCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      speed: 'standard',
    })
    const opusFast = calculateUsdCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      speed: 'fast',
    })
    expect(opusStd).toBeCloseTo(30, 6)
    expect(opusFast).toBeCloseTo(180, 6)

    // Session tracker accumulate, format, save, and restore
    const currentSessionId = getSessionId()
    addToTotalSessionCost(
      sonnetCost,
      {
        ...EMPTY_USAGE,
        input_tokens: 1_000_000,
        output_tokens: 100_000,
      },
      'claude-sonnet-4-6',
    )
    expect(getTotalCost()).toBeCloseTo(sonnetCost, 6)
    expect(formatTotalCost()).toContain('Total cost:')
    expect(formatTotalCost()).toContain('claude-sonnet-4-6')

    saveCurrentSessionCosts()
    const restored = getStoredSessionCosts(currentSessionId)
    expect(restored?.totalCostUsd).toBeCloseTo(sonnetCost, 6)
    expect(restored?.modelUsage?.['claude-sonnet-4-6']?.inputTokens).toBe(
      1_000_000,
    )
  })

  test('VCR dehydrates paths, records deterministic fixtures, and replays with cost accounting', async () => {
    process.env.COPILOT_CLI_TEST_FIXTURES_ROOT = tempDir
    process.env.VCR_RECORD = '1'

    const promptMsg = createUserMessage({ content: 'Say hello' })
    const hash1 = computeVcrHash([promptMsg])
    const hash2 = computeVcrHash([createUserMessage({ content: 'Say hello' })])
    expect(hash1).toBe(hash2)

    const dehydrated = dehydrateValue({
      text: `Dir ${tempDir} at 2026-01-01T00:00:00.000Z in 120ms`,
    })
    expect(dehydrated.text).toContain('[CONFIG_HOME]')
    expect(dehydrated.text).toContain('[TIMESTAMP]')
    expect(dehydrated.text).toContain('[DURATION]')
    expect(hydrateValue(dehydrated).text).toContain(tempDir)

    const fakeAssistant: AssistantMessage = {
      type: 'assistant',
      requestId: 'req_vcr_1',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_vcr_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'Hello from VCR!' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      } as AssistantMessage['message'],
    }

    // Record phase
    let liveCalls = 0
    const recorded = await withVcr([promptMsg], async () => {
      liveCalls++
      return [fakeAssistant]
    })
    expect(liveCalls).toBe(1)
    expect(recorded).toHaveLength(1)

    // Replay phase (VCR_RECORD off, VCR_ENABLED on)
    delete process.env.VCR_RECORD
    process.env.VCR_ENABLED = '1'
    resetCostState()

    const replayed = await withVcr([promptMsg], async () => {
      liveCalls++
      throw new Error('Should not execute live call during replay')
    })
    expect(liveCalls).toBe(1)
    expect(replayed).toHaveLength(1)
    expect(getTotalCost()).toBeGreaterThan(0)

    // Streaming VCR replay
    const streamItems = []
    for await (const item of withStreamingVcr([promptMsg], async function* () {
      liveCalls++
      yield fakeAssistant
    })) {
      streamItems.push(item)
    }
    expect(liveCalls).toBe(1)
    expect(streamItems).toHaveLength(1)
  })
})
