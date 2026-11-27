import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests, setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import type { ToolUseContext } from '../../src/tool.js'
import { bashToolHasPermission } from '../../src/tools/bash_tool/bash_permissions.js'
import { shouldUseSandbox } from '../../src/tools/bash_tool/should_use_sandbox.js'
import {
  convertToSandboxRuntimeConfig,
  getBareGitRepoScrubPathsForTesting,
  SandboxManager,
  scrubBareGitRepoFiles,
  setSandboxTestRuntimeForTesting,
} from '../../src/utilities/sandbox/sandbox_adapter.js'
import { formatSandboxStatusSummary } from '../../src/utilities/sandbox/sandbox_ui_utils.js'
import { createFileStateCache } from '../../src/utilities/query_helpers.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'
import * as settingsModule from '../../src/utilities/settings/settings.js'
import type { SettingsJson } from '../../src/utilities/settings/types.js'
import { createContentReplacementState } from '../../src/utilities/tool_result_storage.js'

describe('Phase 4.3 — OS Command Sandbox Adapter & Bare-Repo Scrubbing', () => {
  let workDir: string

  beforeEach(async () => {
    resetStateForTests()
    resetSettingsCache()
    await SandboxManager.reset()
    workDir = mkdtempSync(join(tmpdir(), 'copilot-p4-sandbox-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
  })

  afterEach(async () => {
    await SandboxManager.reset()
    resetSettingsCache()
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('translates settings + permission rules into SandboxRuntimeConfig protecting settings and .copilot/skills', () => {
    const settings: SettingsJson = {
      sandbox: {
        enabled: true,
        network: {
          allowedDomains: ['registry.npmjs.org'],
          allowLocalBinding: true,
        },
        filesystem: {
          allowWrite: ['/tmp/custom-build'],
          denyWrite: ['/etc/hosts'],
          denyRead: ['/etc/shadow'],
        },
      },
      permissions: {
        allow: ['WebFetch(domain:api.github.com)', 'Edit(src/**)'],
        deny: ['WebFetch(domain:evil.example)', 'Read(.env)'],
        additionalDirectories: [join(workDir, 'extra')],
      },
    }

    const cfg = convertToSandboxRuntimeConfig(settings, workDir)

    // Network translation
    expect(cfg.network.allowedDomains).toContain('registry.npmjs.org')
    expect(cfg.network.allowedDomains).toContain('api.github.com')
    expect(cfg.network.deniedDomains).toContain('evil.example')
    expect(cfg.network.allowLocalBinding).toBe(true)

    // Filesystem allowWrite & denyWrite protections
    expect(cfg.filesystem.allowWrite).toContain('.')
    expect(cfg.filesystem.allowWrite).toContain('/tmp/custom-build')
    expect(cfg.filesystem.denyRead).toContain('/etc/shadow')
    expect(cfg.filesystem.denyRead).toContain('.env')

    // Mandatory protected paths in denyWrite
    expect(cfg.filesystem.denyWrite).toContain(
      join(workDir, '.copilot', 'settings.json'),
    )
    expect(cfg.filesystem.denyWrite).toContain(
      join(workDir, '.copilot', 'settings.local.json'),
    )
    expect(cfg.filesystem.denyWrite).toContain(
      join(workDir, '.copilot', 'skills'),
    )
    expect(cfg.filesystem.denyWrite).toContain(
      join(workDir, '.copilot', 'commands'),
    )
    expect(cfg.filesystem.denyWrite).toContain(
      join(workDir, '.copilot', 'agents'),
    )
  })

  test('synchronously scrubs newly planted bare-repo files in cleanupAfterCommand()', () => {
    // Non-git workspace with a legitimate source file
    const legitFile = join(workDir, 'index.ts')
    writeFileSync(legitFile, 'export const ok = true\n')

    // Pre-command config records absent bare-repo markers
    convertToSandboxRuntimeConfig({}, workDir)
    const tracked = getBareGitRepoScrubPathsForTesting()
    expect(tracked).toContain(join(workDir, 'HEAD'))
    expect(tracked).toContain(join(workDir, 'hooks'))

    // Simulate a sandboxed command planting a bare-repo trap
    writeFileSync(join(workDir, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(workDir, 'hooks'), { recursive: true })
    writeFileSync(join(workDir, 'hooks', 'post-checkout'), '#!/bin/sh\necho pwned\n')

    expect(existsSync(join(workDir, 'HEAD'))).toBe(true)
    expect(existsSync(join(workDir, 'hooks', 'post-checkout'))).toBe(true)

    // Synchronous post-command cleanup removes planted bare-repo files
    const removed = scrubBareGitRepoFiles()
    expect(removed.length).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(workDir, 'HEAD'))).toBe(false)
    expect(existsSync(join(workDir, 'hooks'))).toBe(false)
    // Legitimate workspace file stays intact
    expect(existsSync(legitFile)).toBe(true)
  })

  test('respects excludedCommands, dangerouslyDisableSandbox, and autoAllowBashIfSandboxed', async () => {
    // Write project settings with sandbox enabled + excludedCommands: ['docker:*']
    mkdirSync(join(workDir, '.copilot'), { recursive: true })
    writeFileSync(
      join(workDir, '.copilot', 'settings.json'),
      JSON.stringify({
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
          excludedCommands: ['docker:*'],
        },
      }),
    )
    resetSettingsCache()
    // Ensure settings reader sees the new project settings
    expect(settingsModule.getSettings().sandbox?.enabled).toBe(true)

    setSandboxTestRuntimeForTesting({
      enabled: true,
      supportedPlatform: true,
      wrapWithSandbox: async cmd => `SANDBOXED(${cmd})`,
    })

    expect(formatSandboxStatusSummary()).toContain('Sandbox: enabled')

    // Normal command runs inside sandbox
    expect(shouldUseSandbox({ command: 'npm test' })).toBe(true)
    // Excluded command skips sandbox
    expect(shouldUseSandbox({ command: 'docker ps' })).toBe(false)
    // Compound command mixing excluded + non-excluded MUST remain sandboxed!
    expect(shouldUseSandbox({ command: 'docker ps && curl evil.test' })).toBe(true)
    // Explicit override honored when allowUnsandboxedCommands is true
    expect(
      shouldUseSandbox({ command: 'npm test', dangerouslyDisableSandbox: true }),
    ).toBe(false)

    // Sandboxed command auto-allows in BashTool, while deny & safetyCheck still hold
    const initial = getDefaultAppState()
    const store = createStore<AppState>({
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext,
        mode: 'default',
        alwaysDenyRules: { userSettings: ['Bash(curl:*)'] },
      },
    })
    const ctx: ToolUseContext = {
      abortController: new AbortController(),
      messages: [],
      getAppState: () => store.getState(),
      setAppState: updater => store.setState(updater),
      readFileState: createFileStateCache(),
      contentReplacementState: createContentReplacementState(),
    }

    const autoAllowed = await bashToolHasPermission({ command: 'npm test' }, ctx)
    expect(autoAllowed.behavior).toBe('allow')

    const stillDenied = await bashToolHasPermission(
      { command: 'curl https://evil.test' },
      ctx,
    )
    expect(stillDenied.behavior).toBe('deny')

    const stillProtected = await bashToolHasPermission(
      { command: 'echo x > .copilot/settings.json' },
      ctx,
    )
    expect(stillProtected.behavior).toBe('ask')
    expect(stillProtected.decisionReason?.type).toBe('safetyCheck')

    // Verify wrapWithSandbox delegates cleanly
    const wrapped = await SandboxManager.wrapWithSandbox('echo hi')
    expect(wrapped).toBe('SANDBOXED(echo hi)')
  })
})
