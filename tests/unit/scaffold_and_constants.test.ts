import { afterEach, describe, expect, test } from 'bun:test'
import {
  API_IMAGE_MAX_BASE64_SIZE,
  API_MAX_MEDIA_PER_REQUEST,
  API_PDF_MAX_PAGES,
  IMAGE_TARGET_RAW_SIZE,
} from '../../src/constants/api_limits.js'
import {
  getLocalIsoDate,
  getLocalMonthYear,
} from '../../src/constants/common.js'
import { CYBER_RISK_INSTRUCTION } from '../../src/constants/cyber_risk_instruction.js'
import { E_TOOL_USE_SUMMARY_GENERATION_FAILED } from '../../src/constants/error_ids.js'
import {
  BINARY_EXTENSIONS,
  hasBinaryExtension,
  isBinaryContent,
} from '../../src/constants/files.js'
import { getGrowthBookClientKey } from '../../src/constants/keys.js'
import { NO_CONTENT_MESSAGE } from '../../src/constants/messages.js'
import {
  CLAUDE_AI_BASE_URL,
  CLAUDE_AI_LOCAL_BASE_URL,
  CLAUDE_AI_STAGING_BASE_URL,
  getClaudeAiBaseUrl,
  getRemoteSessionUrl,
  isRemoteSessionLocal,
  isRemoteSessionStaging,
  setCompatSessionIdTranslator,
} from '../../src/constants/product.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_TOKENS,
  MAX_TOOL_RESULTS_PER_MESSAGE_CHARS,
  TOOL_SUMMARY_MAX_LENGTH,
} from '../../src/constants/tool_limits.js'
import {
  BASH_INPUT_TAG,
  COMMAND_NAME_TAG,
  TERMINAL_OUTPUT_TAGS,
} from '../../src/constants/xml.js'
import { asAgentId, asSessionId, toAgentId } from '../../src/types/ids.js'
import {
  EXTERNAL_PERMISSION_MODES,
  INTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
} from '../../src/types/permissions.js'
import {
  clearFeatureOverridesForTesting,
  DEFAULT_MACROS,
  FEATURE_FLAGS,
  isFeatureEnabled,
  setFeatureOverrideForTesting,
} from '../../src/utils/feature_flags.js'

describe('Step 0.1 — MACRO globals & feature flags', () => {
  afterEach(() => {
    clearFeatureOverridesForTesting()
  })

  test('MACRO global is initialized by test preload', () => {
    expect(MACRO.VERSION).toBe(DEFAULT_MACROS.VERSION)
    expect(typeof MACRO.BUILD_TIME).toBe('string')
    expect(MACRO.PACKAGE_URL).toBe(DEFAULT_MACROS.PACKAGE_URL)
    expect(MACRO.ISSUES_EXPLAINER).toBe(DEFAULT_MACROS.ISSUES_EXPLAINER)
    expect(MACRO.FEEDBACK_CHANNEL).toBe(DEFAULT_MACROS.FEEDBACK_CHANNEL)
    expect(MACRO.NATIVE_PACKAGE_URL).toBe(DEFAULT_MACROS.NATIVE_PACKAGE_URL)
    expect(MACRO.VERSION_CHANGELOG).toBe(DEFAULT_MACROS.VERSION_CHANGELOG)
  })

  test('FEATURE_FLAGS contains all 90 compile-time gates', () => {
    expect(FEATURE_FLAGS.length).toBe(90)
    expect(new Set(FEATURE_FLAGS).size).toBe(90)
  })

  test('feature flags default to false and support runtime overrides', () => {
    expect(isFeatureEnabled('KAIROS')).toBe(false)
    setFeatureOverrideForTesting('KAIROS', true)
    expect(isFeatureEnabled('KAIROS')).toBe(true)
    setFeatureOverrideForTesting('KAIROS', undefined)
    expect(isFeatureEnabled('KAIROS')).toBe(false)
  })
})

describe('Step 0.2 — Leaf constants & branded IDs/permissions', () => {
  afterEach(() => {
    setCompatSessionIdTranslator(undefined)
    delete process.env.CLAUDE_CODE_OVERRIDE_DATE
  })

  test('common date helpers honor CLAUDE_CODE_OVERRIDE_DATE', () => {
    process.env.CLAUDE_CODE_OVERRIDE_DATE = '2026-03-15'
    expect(getLocalIsoDate()).toBe('2026-03-15')
    expect(getLocalMonthYear()).toContain('2026')
  })

  test('product URL routing & compat session ID translation', () => {
    expect(isRemoteSessionStaging('session_staging_123')).toBe(true)
    expect(isRemoteSessionLocal('session_local_123')).toBe(true)
    expect(getClaudeAiBaseUrl('session_123')).toBe(CLAUDE_AI_BASE_URL)
    expect(getClaudeAiBaseUrl('session_staging_123')).toBe(
      CLAUDE_AI_STAGING_BASE_URL,
    )
    expect(getClaudeAiBaseUrl('session_local_123')).toBe(
      CLAUDE_AI_LOCAL_BASE_URL,
    )
    expect(getRemoteSessionUrl('cse_abc123')).toBe(
      `${CLAUDE_AI_BASE_URL}/code/session_abc123`,
    )
    setCompatSessionIdTranslator(id => id)
    expect(getRemoteSessionUrl('cse_abc123')).toBe(
      `${CLAUDE_AI_BASE_URL}/code/cse_abc123`,
    )
  })

  test('binary file detection handles extensions and byte buffers', () => {
    expect(BINARY_EXTENSIONS.has('.png')).toBe(true)
    expect(hasBinaryExtension('photo.PNG')).toBe(true)
    expect(hasBinaryExtension('README.md')).toBe(false)
    expect(hasBinaryExtension('Makefile')).toBe(false)

    expect(isBinaryContent(Buffer.from('hello world\n\ttext'))).toBe(false)
    expect(isBinaryContent(Buffer.from([0x41, 0x00, 0x42]))).toBe(true)
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false)
  })

  test('static constants match reference specifications', () => {
    expect(E_TOOL_USE_SUMMARY_GENERATION_FAILED).toBe(344)
    expect(getGrowthBookClientKey()).toBe('sdk-zAZezfDKGoZuXXKe')
    expect(NO_CONTENT_MESSAGE).toBe('(no content)')
    expect(COMMAND_NAME_TAG).toBe('command-name')
    expect(TERMINAL_OUTPUT_TAGS).toContain(BASH_INPUT_TAG)
    expect(IMAGE_TARGET_RAW_SIZE).toBe((API_IMAGE_MAX_BASE64_SIZE * 3) / 4)
    expect(API_PDF_MAX_PAGES).toBe(100)
    expect(API_MAX_MEDIA_PER_REQUEST).toBe(100)
    expect(DEFAULT_MAX_RESULT_SIZE_CHARS).toBe(50_000)
    expect(MAX_TOOL_RESULT_BYTES).toBe(MAX_TOOL_RESULT_TOKENS * BYTES_PER_TOKEN)
    expect(MAX_TOOL_RESULTS_PER_MESSAGE_CHARS).toBe(200_000)
    expect(TOOL_SUMMARY_MAX_LENGTH).toBe(50)
    expect(CYBER_RISK_INSTRUCTION).toContain('authorized security testing')
  })

  test('branded IDs and agent ID validation', () => {
    const sid = asSessionId('550e8400-e29b-41d4-a716-446655440000')
    const aid = asAgentId('a0123456789abcdef')
    expect<string>(sid).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect<string>(aid).toBe('a0123456789abcdef')
    expect<string | null>(toAgentId('a0123456789abcdef')).toBe(
      'a0123456789abcdef',
    )
    expect<string | null>(toAgentId('acompact-0123456789abcdef')).toBe(
      'acompact-0123456789abcdef',
    )
    expect(toAgentId('teammate-name')).toBeNull()
  })

  test('permission modes preserve external/internal boundaries', () => {
    expect(EXTERNAL_PERMISSION_MODES).toEqual([
      'acceptEdits',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ])
    expect(PERMISSION_MODES).toEqual(INTERNAL_PERMISSION_MODES)
  })
})
