import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '../../src/constants/prompts.js'
import {
  clearSystemPromptSections,
  dangerousUncachedSystemPromptSection,
  resolveSystemPromptSections,
  systemPromptSection,
} from '../../src/constants/system_prompt_sections.js'
import { getCliSyspromptPrefix } from '../../src/constants/system.js'
import {
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  stripExcessMediaItems,
} from '../../src/services/api/claude.js'
import type { AssistantMessage, UserMessage } from '../../src/types/message.js'
import { splitSysPromptPrefix } from '../../src/utilities/api.js'
import {
  getAttachments,
  wrapInSystemReminder,
} from '../../src/utilities/attachments.js'
import {
  clearMemoryFileCaches,
  getClaudeMds,
  getConditionalRulesForCwdLevelDirectory,
  getMemoryFiles,
} from '../../src/utilities/claudemd.js'
import { computeFingerprint } from '../../src/utilities/fingerprint.js'
import { parseConfigString } from '../../src/utilities/git/git_config_parser.js'
import { normalizeGitRemoteUrl } from '../../src/utilities/git.js'
import {
  createUserMessage,
  ensureToolResultPairing,
  normalizeAttachmentForApi,
  normalizeMessagesForApi,
} from '../../src/utilities/messages.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import { updateSettingsForSource } from '../../src/utilities/settings/settings.js'
import {
  asSystemPrompt,
  buildEffectiveSystemPrompt,
} from '../../src/utilities/system_prompt.js'

let tempRoot = ''
let savedConfigDir: string | undefined
let savedUseBedrock: string | undefined

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  savedUseBedrock = process.env.COPILOT_CLI_USE_BEDROCK
  delete process.env.COPILOT_CLI_USE_BEDROCK

  tempRoot = mkdtempSync(join(tmpdir(), 'copilot-phase2-prompts-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true })

  resetStateForTests()
  resetSettingsCache()
  clearMemoryFileCaches()
  clearSystemPromptSections()
})

afterEach(() => {
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (savedUseBedrock === undefined) {
    delete process.env.COPILOT_CLI_USE_BEDROCK
  } else {
    process.env.COPILOT_CLI_USE_BEDROCK = savedUseBedrock
  }
  resetStateForTests()
  resetSettingsCache()
  clearMemoryFileCaches()
  clearSystemPromptSections()
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

describe('Step 2.4 — System Prompt, Cache Breakpoints, CLAUDE.md, and Messages', () => {
  test('system prompt assembly includes dynamic boundary, precedence rules, and session-cached sections', async () => {
    const prompt = await getSystemPrompt([], 'claude-sonnet-4-6')
    expect(prompt).toContain(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)

    // Precedence: override > coordinator > custom > default + append
    expect(
      buildEffectiveSystemPrompt({
        defaultSystemPrompt: ['def'],
        customSystemPrompt: 'custom',
        overrideSystemPrompt: 'override',
        appendSystemPrompt: 'append',
      }),
    ).toEqual(asSystemPrompt(['override']))

    expect(
      buildEffectiveSystemPrompt({
        defaultSystemPrompt: ['def'],
        customSystemPrompt: 'custom',
        appendSystemPrompt: 'append',
      }),
    ).toEqual(asSystemPrompt(['custom', 'append']))

    // Session-cached vs uncached sections
    let cachedCount = 0
    let uncachedCount = 0
    const sections = [
      systemPromptSection('static_dynamic', () => {
        cachedCount++
        return `cached-${cachedCount}`
      }),
      dangerousUncachedSystemPromptSection(
        'live_dynamic',
        () => {
          uncachedCount++
          return `live-${uncachedCount}`
        },
        'test',
      ),
    ]

    const first = await resolveSystemPromptSections(sections)
    const second = await resolveSystemPromptSections(sections)
    expect(first).toEqual(['cached-1', 'live-1'])
    expect(second).toEqual(['cached-1', 'live-2'])

    clearSystemPromptSections()
    const third = await resolveSystemPromptSections(sections)
    expect(third).toEqual(['cached-2', 'live-3'])
  })

  test('Prompt Cache breakpoints split global/org system prompt and place single tail message breakpoint (with skipCacheWrite)', () => {
    const prompt = asSystemPrompt([
      'x-anthropic-billing-header: cc_version=0.0.1.abc;',
      getCliSyspromptPrefix(),
      'Static instruction A',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'Dynamic workspace info',
    ])

    // 1P global cache scope
    const blocks1p = buildSystemPromptBlocks(prompt, true)
    expect(blocks1p).toHaveLength(4)
    expect(
      (blocks1p[0] as unknown as Record<string, unknown>).cache_control,
    ).toBeUndefined()
    expect(
      (blocks1p[2] as unknown as Record<string, unknown>).cache_control,
    ).toMatchObject({ type: 'ephemeral', scope: 'global' })
    expect(
      (blocks1p[3] as unknown as Record<string, unknown>).cache_control,
    ).toBeUndefined()

    // Non-global / MCP fallback marks org scope (omits scope field)
    const splitOrg = splitSysPromptPrefix(prompt, {
      skipGlobalCacheForSystemPrompt: true,
    })
    expect(splitOrg.some(b => b.cacheScope === 'org')).toBe(true)
    expect(splitOrg.some(b => b.cacheScope === 'global')).toBe(false)

    // Message tail breakpoint: normal -> index len-1, skipCacheWrite -> index len-2
    const u1 = createUserMessage({ content: 'turn 1' })
    const u2 = createUserMessage({ content: 'turn 2' })
    const normalParams = addCacheBreakpoints([u1, u2], true, 'sdk', false)
    expect(typeof normalParams[0]!.content).toBe('string')
    expect(Array.isArray(normalParams[1]!.content)).toBe(true)

    const forkParams = addCacheBreakpoints([u1, u2], true, 'sdk', true)
    expect(Array.isArray(forkParams[0]!.content)).toBe(true)
    expect(typeof forkParams[1]!.content).toBe('string')
  })

  test('INSTRUCTIONS.md layered precedence, @include expansion/cycle/depth, HTML stripping, excludes, and conditional rules (no legacy CLAUDE.md fallback)', async () => {
    const userInstructionsPath = join(
      process.env.CLAUDE_CONFIG_DIR!,
      'INSTRUCTIONS.md',
    )
    const projectParent = join(tempRoot, 'workspace')
    const projectChild = join(projectParent, 'packages', 'app')
    const rulesDir = join(projectChild, '.copilot', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    mkdirSync(join(projectChild, 'src'), { recursive: true })

    // Legacy CLAUDE.md must NOT be loaded
    writeFileSync(
      join(projectChild, 'CLAUDE.md'),
      'Legacy claude rule should be ignored',
      'utf-8',
    )

    // 1. User INSTRUCTIONS.md
    writeFileSync(
      userInstructionsPath,
      'User global rule\n<!-- hidden comment -->',
      'utf-8',
    )

    // 2. Parent ancestor INSTRUCTIONS.md
    writeFileSync(
      join(projectParent, 'INSTRUCTIONS.md'),
      'Workspace parent rule\n```\n@./ignored_in_code.md\n```',
      'utf-8',
    )

    // 3. Project INSTRUCTIONS.md with @include + cycle back-reference
    writeFileSync(
      join(projectChild, 'INSTRUCTIONS.md'),
      'App project rule\n@./extra.md',
      'utf-8',
    )
    writeFileSync(
      join(projectChild, 'extra.md'),
      'Included extra rule\n@./INSTRUCTIONS.md',
      'utf-8',
    )

    // 4. Local INSTRUCTIONS.local.md
    writeFileSync(
      join(projectChild, 'INSTRUCTIONS.local.md'),
      'Private local rule',
      'utf-8',
    )

    // 5. Conditional rule for src/**/*.ts
    writeFileSync(
      join(rulesDir, 'ts-only.md'),
      '---\npaths:\n  - src/**/*.ts\n---\nUse strict TS types.',
      'utf-8',
    )

    setOriginalCwd(projectChild)
    const files = await getMemoryFiles(false)

    const contents = files.map(f => f.content.trim())
    expect(
      contents.some(c => c.includes('Legacy claude rule should be ignored')),
    ).toBe(false)
    const userIdx = contents.findIndex(c => c.includes('User global rule'))
    const parentIdx = contents.findIndex(c => c.includes('Workspace parent rule'))
    const appIdx = contents.findIndex(c => c.includes('App project rule'))
    const includeIdx = contents.findIndex(c => c.includes('Included extra rule'))
    const localIdx = contents.findIndex(c => c.includes('Private local rule'))

    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(parentIdx).toBeGreaterThan(userIdx)
    expect(appIdx).toBeGreaterThan(parentIdx)
    expect(includeIdx).toBeGreaterThan(appIdx)
    expect(localIdx).toBeGreaterThan(includeIdx)

    // HTML comment was stripped
    expect(files[userIdx]!.content).not.toContain('hidden comment')
    // Conditional rule was NOT loaded unconditionally
    expect(contents.some(c => c.includes('Use strict TS types'))).toBe(false)

    // Conditional rule activates for matching target file
    const matched = getConditionalRulesForCwdLevelDirectory(
      projectChild,
      join(projectChild, 'src', 'index.ts'),
      new Set(),
    )
    expect(matched).toHaveLength(1)
    expect(matched[0]!.content).toContain('Use strict TS types.')

    // claudeMdExcludes filters matching non-managed file
    updateSettingsForSource('userSettings', {
      claudeMdExcludes: ['**/INSTRUCTIONS.local.md'],
    })
    resetSettingsCache()
    clearMemoryFileCaches()
    const filteredFiles = await getMemoryFiles(false)
    expect(
      filteredFiles.some(f => f.content.includes('Private local rule')),
    ).toBe(false)

    // Formatted prompt text includes override header
    expect(getClaudeMds(filteredFiles)).toContain(
      'Codebase and user instructions are shown below',
    )
  })

  test('fingerprint, git config parser, remote URL normalization, message pairing, media cap (100), and attachments', async () => {
    expect(computeFingerprint('hello world', '0.0.1')).toMatch(/^[0-9a-f]{3}$/)
    expect(computeFingerprint('hello world', '0.0.1')).toBe(
      computeFingerprint('hello world', '0.0.1'),
    )

    const sections = parseConfigString(
      '[core]\n\tbare = true\n[remote "origin"]\n\turl = git@github.com:org/repo.git\n',
    )
    expect(sections.get('core.bare')).toBe('true')
    expect(normalizeGitRemoteUrl('git@github.com:org/repo.git')).toBe(
      'github.com/org/repo',
    )

    // ensureToolResultPairing synthesizes missing tool_result for unmatched tool_use
    const assistantWithTool: AssistantMessage = {
      type: 'assistant',
      requestId: 'req_tool_1',
      uuid: '00000000-0000-4000-8000-000000000010',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_tool_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_missing_1',
            name: 'Read',
            input: { file_path: 'a.ts' },
          },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      } as AssistantMessage['message'],
    }
    const followUpUser = createUserMessage({ content: 'Continue anyway' })
    const normalized = normalizeMessagesForApi([assistantWithTool, followUpUser])
    const paired = ensureToolResultPairing(normalized)
    const hasSyntheticResult = paired.some(
      m =>
        m.type === 'user' &&
        Array.isArray(m.message.content) &&
        m.message.content.some(
          b => b.type === 'tool_result' && b.tool_use_id === 'toolu_missing_1',
        ),
    )
    expect(hasSyntheticResult).toBe(true)

    // stripExcessMediaItems enforces cap (100 default, tested with 105 -> 100)
    const mediaMessages: UserMessage[] = Array.from({ length: 105 }, (_, i) =>
      createUserMessage({
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: `img_${i}`,
            },
          },
          { type: 'text', text: `caption ${i}` },
        ],
      }),
    )
    const stripped = stripExcessMediaItems(mediaMessages, 100)
    const remainingImages = stripped.flatMap(m =>
      Array.isArray(m.message.content)
        ? m.message.content.filter(b => b.type === 'image')
        : [],
    )
    expect(remainingImages).toHaveLength(100)

    // Attachment normalization wraps in <system-reminder>
    expect(wrapInSystemReminder('alert')).toBe(
      '<system-reminder>\nalert\n</system-reminder>',
    )
    const dateMsgs = normalizeAttachmentForApi({
      type: 'date_change',
      newDate: '2026-11-26',
    })
    expect(dateMsgs).toHaveLength(1)
    expect(dateMsgs[0]!.isMeta).toBe(true)
    expect(String(dateMsgs[0]!.message.content)).toContain('<system-reminder>')

    const generatedAttachments = await getAttachments('hello', {
      abortController: new AbortController(),
      messages: [],
      options: {},
    })
    expect(Array.isArray(generatedAttachments)).toBe(true)
  })
})
