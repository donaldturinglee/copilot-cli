import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resetStateForTests,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  registerHookCallbacks,
} from '../../src/bootstrap/state.js'
import { runHeadless } from '../../src/cli/print.js'
import { productionDeps, type QueryDeps } from '../../src/query/deps.js'
import type { AssistantMessage } from '../../src/types/message.js'
import {
  resetOnceHooksForTesting,
} from '../../src/utilities/hooks.js'
import { resetPhase4BootstrapForTesting } from '../../src/utilities/hooks/bootstrap_hooks.js'
import {
  resetHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from '../../src/utilities/hooks/hooks_config_snapshot.js'
import { createAssistantMessage } from '../../src/utilities/messages.js'
import {
  SandboxManager,
  setSandboxTestRuntimeForTesting,
} from '../../src/utilities/sandbox/sandbox_adapter.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

describe('Phase 4 M2 Milestone — Headless -p Coding Loop with Permissions, Sandbox, & Hooks', () => {
  let workDir: string

  beforeEach(async () => {
    resetStateForTests()
    resetSettingsCache()
    resetHooksConfigSnapshot()
    resetOnceHooksForTesting()
    resetPhase4BootstrapForTesting()
    await SandboxManager.reset()
    setIsInteractive(false)

    workDir = mkdtempSync(join(tmpdir(), 'copilot-p4-m2-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
    mkdirSync(join(workDir, 'src'), { recursive: true })
    mkdirSync(join(workDir, '.copilot'), { recursive: true })
    writeFileSync(
      join(workDir, 'src', 'math.ts'),
      'export function add(a: number, b: number): number {\n  return a - b\n}\n',
    )
    writeFileSync(
      join(workDir, '.copilot', 'settings.json'),
      JSON.stringify({
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
        },
      }),
    )
    resetSettingsCache()
    updateHooksConfigSnapshot()
  })

  afterEach(async () => {
    await SandboxManager.reset()
    resetHooksConfigSnapshot()
    resetSettingsCache()
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('executes read/search/edit/test loop with safetyCheck isolation, sandbox bare-repo scrub, PreToolUse rewrite/block, PostToolUse context, and Stop hook retry', async () => {
    const mathFile = join(workDir, 'src', 'math.ts')
    const settingsFile = join(workDir, '.copilot', 'settings.json')

    // Track sandbox wrapping & bare-repo scrubbing
    const sandboxWrappedCommands: string[] = []
    let sandboxCleanups = 0
    setSandboxTestRuntimeForTesting({
      enabled: true,
      supportedPlatform: true,
      wrapWithSandbox: async cmd => {
        sandboxWrappedCommands.push(cmd)
        return cmd
      },
      onCleanupAfterCommand: () => {
        sandboxCleanups++
      },
    })

    // Track lifecycle hook executions
    const observedEvents: string[] = []
    let stopAttempts = 0

    registerHookCallbacks({
      SessionStart: [
        {
          hooks: [
            async () => {
              observedEvents.push('SessionStart')
              return {
                hookSpecificOutput: {
                  hookEventName: 'SessionStart',
                  additionalContext: 'M2-session-started',
                },
              }
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            async (input: unknown) => {
              const payload = input as { tool_input: { command?: string } }
              const cmd = payload.tool_input.command ?? ''
              observedEvents.push(`PreToolUse:Bash:${cmd}`)
              if (cmd.includes('FORBIDDEN_HOOK_CMD')) {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: 'Blocked by M2 PreToolUse policy hook',
                  },
                }
              }
              if (cmd === 'echo ORIGINAL_CMD') {
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    updatedInput: { command: 'echo REWRITTEN_BY_HOOK && touch HEAD' },
                  },
                }
              }
              return {}
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit',
          hooks: [
            async () => {
              observedEvents.push('PostToolUse:Edit')
              return {
                hookSpecificOutput: {
                  hookEventName: 'PostToolUse',
                  additionalContext: 'PostToolUse verified edit diff',
                },
              }
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            async (input: unknown) => {
              const payload = input as { stop_hook_active?: boolean }
              stopAttempts++
              observedEvents.push(`Stop:${Boolean(payload.stop_hook_active)}`)
              if (!payload.stop_hook_active) {
                return {
                  decision: 'block',
                  reason: 'Confirm final summary mentions REWRITTEN_BY_HOOK',
                }
              }
              return { decision: 'approve' }
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            async () => {
              observedEvents.push('SessionEnd')
              return {}
            },
          ],
        },
      ],
    })

    // Deterministic scripted multi-turn coding model
    let modelTurn = 0
    const seenToolResults: string[] = []
    const baseDeps = productionDeps()
    const mockDeps: QueryDeps = {
      ...baseDeps,
      async *callModel(params) {
        modelTurn++
        // Capture tool results from prior turn for assertions
        for (const m of params.messages) {
          if (m.type === 'user' && Array.isArray(m.message.content)) {
            for (const block of m.message.content) {
              if (block.type === 'tool_result' && typeof block.content === 'string') {
                seenToolResults.push(block.content)
              }
            }
          }
        }

        const emit = (
          msg: AssistantMessage,
          stopReason: 'tool_use' | 'end_turn',
        ): AssistantMessage => ({
          ...msg,
          message: {
            ...msg.message,
            stop_reason: stopReason,
          },
        })

        if (modelTurn === 1) {
          // Turn 1: Read math.ts, Read .copilot/settings.json, + Grep concurrently
          yield emit(
            createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-read',
                  name: 'Read',
                  input: { file_path: mathFile },
                },
                {
                  type: 'tool_use',
                  id: 'tu-read-settings',
                  name: 'Read',
                  input: { file_path: settingsFile },
                },
                {
                  type: 'tool_use',
                  id: 'tu-grep',
                  name: 'Grep',
                  input: { pattern: 'return a - b', path: workDir },
                },
              ],
            }),
            'tool_use',
          )
          return
        }

        if (modelTurn === 2) {
          // Turn 2: Edit src/math.ts (legit) + attempt Edit .copilot/settings.json (MUST fail safetyCheck even under bypassPermissions!)
          yield emit(
            createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-edit-ok',
                  name: 'Edit',
                  input: {
                    file_path: mathFile,
                    old_string: 'return a - b',
                    new_string: 'return a + b',
                  },
                },
                {
                  type: 'tool_use',
                  id: 'tu-edit-settings',
                  name: 'Edit',
                  input: {
                    file_path: settingsFile,
                    old_string: '"enabled":true',
                    new_string: '"enabled":false',
                  },
                },
              ],
            }),
            'tool_use',
          )
          return
        }

        if (modelTurn === 3) {
          // Turn 3: Bash rewritten by PreToolUse hook (and plants bare-repo HEAD which sandbox cleanup scrubs!),
          // plus Bash blocked by PreToolUse hook, plus Bash denied by --disallowed-tools!
          yield emit(
            createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'tu-bash-rewrite',
                  name: 'Bash',
                  input: { command: 'echo ORIGINAL_CMD' },
                },
                {
                  type: 'tool_use',
                  id: 'tu-bash-hook-block',
                  name: 'Bash',
                  input: { command: 'echo FORBIDDEN_HOOK_CMD' },
                },
                {
                  type: 'tool_use',
                  id: 'tu-bash-cli-deny',
                  name: 'Bash',
                  input: { command: 'rm -f src/math.ts' },
                },
              ],
            }),
            'tool_use',
          )
          return
        }

        if (modelTurn === 4) {
          // Turn 4: First completion attempt -> blocked by Stop hook!
          yield emit(
            createAssistantMessage({
              content: 'Initial fix complete.',
            }),
            'end_turn',
          )
          return
        }

        // Turn 5: Follow-up after Stop hook feedback -> approved!
        yield emit(
          createAssistantMessage({
            content:
              'Fixed src/math.ts and confirmed REWRITTEN_BY_HOOK ran safely.',
          }),
          'end_turn',
        )
      },
    }

    let stdout = ''
    const run = await runHeadless('Fix the add() bug in src/math.ts and verify.', {
      outputFormat: 'text',
      dangerouslySkipPermissions: true,
      disallowedTools: ['Bash(rm:*)'],
      deps: mockDeps,
      stdoutWriter: chunk => {
        stdout += chunk
      },
      stderrWriter: () => {},
      skipExit: true,
    })

    // 1. Headless run succeeded cleanly
    expect(run.exitCode).toBe(0)
    expect(stdout).toContain('REWRITTEN_BY_HOOK')

    // 2. Legitimate Edit succeeded on disk
    expect(readFileSync(mathFile, 'utf8')).toContain('return a + b')

    // 3. Sensitive settings edit was BLOCKED despite --dangerously-skip-permissions!
    const settingsOnDisk = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
      sandbox: { enabled: boolean }
    }
    expect(settingsOnDisk.sandbox.enabled).toBe(true)
    expect(
      seenToolResults.some(r =>
        r.includes('Cannot automatically edit Copilot settings file'),
      ),
    ).toBe(true)

    // 4. --disallowed-tools Bash(rm:*) blocked rm despite --dangerously-skip-permissions!
    expect(existsSync(mathFile)).toBe(true)
    expect(seenToolResults.some(r => r.includes('Command denied by rule'))).toBe(true)

    // 5. PreToolUse rewrote Bash command AND blocked FORBIDDEN_HOOK_CMD
    expect(seenToolResults.some(r => r.includes('REWRITTEN_BY_HOOK'))).toBe(true)
    expect(
      seenToolResults.some(r => r.includes('Blocked by M2 PreToolUse policy hook')),
    ).toBe(true)

    // 6. Sandbox wrapped Bash execution AND synchronously scrubbed planted bare-repo `HEAD`!
    expect(sandboxWrappedCommands.length).toBeGreaterThanOrEqual(1)
    expect(sandboxCleanups).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(workDir, 'HEAD'))).toBe(false)

    // 7. Stop hook blocked first stop (stop_hook_active=false) and allowed second (stop_hook_active=true)
    expect(stopAttempts).toBe(2)
    expect(observedEvents).toContain('SessionStart')
    expect(observedEvents).toContain('PostToolUse:Edit')
    expect(observedEvents).toContain('Stop:false')
    expect(observedEvents).toContain('Stop:true')
    expect(observedEvents).toContain('SessionEnd')
  }, 30_000)
})
