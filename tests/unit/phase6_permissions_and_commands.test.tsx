import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { PassThrough } from 'stream'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import {
  getAllCommands,
  getCommandByName,
  isBridgeSafeCommand,
  isRemoteSafeCommand,
} from '../../src/commands.js'
import { App } from '../../src/components/app.js'
import { PermissionRequest } from '../../src/components/permissions/permission_request.js'
import { ConfigDialog } from '../../src/components/settings/config_dialog.js'
import { useCanUseTool } from '../../src/hooks/use_can_use_tool.js'
import { render } from '../../src/ink/root.js'
import { loadOutputStyles } from '../../src/output_styles/load_output_styles_dir.js'
import { Doctor } from '../../src/screens/doctor.js'
import { createAppStateStore } from '../../src/state/app_state_store.js'
import { asAnyTool } from '../../src/tool.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import type { AssistantMessage } from '../../src/types/message.js'
import { runDoctorDiagnostics } from '../../src/utilities/doctor_diagnostic.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

function createStreams(columns = 90, rows = 30) {
  const stdout = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false,
    setRawMode: () => {},
  })
  return { stdout, stdin }
}

describe('Phase 6.5 & 6.6 — Interactive Permissions, /config, Output Styles, & Slash Commands', () => {
  let workDir: string

  beforeEach(() => {
    resetStateForTests()
    resetSettingsCache()
    workDir = mkdtempSync(join(tmpdir(), 'copilot-p6-perm-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
  })

  afterEach(() => {
    resetSettingsCache()
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('interactive FileEdit permission dialog persists Always Allow rule to settings.local.json and live AppState', async () => {
    const { stdout, stdin } = createStreams()
    const store = createAppStateStore()
    let api!: ReturnType<typeof useCanUseTool>

    function Harness() {
      const hook = useCanUseTool()
      api = hook
      return hook.pendingRequest ? (
        <PermissionRequest
          request={hook.pendingRequest}
          onResolve={hook.resolvePendingRequest}
        />
      ) : null
    }

    const inst = render(
      <App store={store}>
        <Harness />
      </App>,
      { stdout, stdin },
    )

    const targetFile = join(workDir, 'app.ts')
    writeFileSync(targetFile, 'const x = 1\n', 'utf8')

    const assistantMsg = {
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000001',
      timestamp: new Date().toISOString(),
      requestId: undefined,
      message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [] },
    } as unknown as AssistantMessage

    const decisionPromise = api.canUseTool(
      asAnyTool(FileEditTool),
      { file_path: targetFile, old_string: 'const x = 1', new_string: 'const x = 2' },
      {
        abortController: new AbortController(),
        messages: [],
        getAppState: () => store.getState(),
        setAppState: store.setState,
        options: { isNonInteractiveSession: false },
      },
      assistantMsg,
      'tu-edit-1',
    )

    // Let microtask mount PermissionRequest dialog
    await new Promise(r => setTimeout(r, 20))
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Edit file:')
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Yes, always allow Edit tool')

    // Move selection down twice to option #3 ("Yes, always allow Edit tool") and press Enter
    stdin.write('\x1b[B')
    stdin.write('\x1b[B')
    stdin.write('\r')
    inst.flush()

    const decision = await decisionPromise
    expect(decision.behavior).toBe('allow')

    // Verify rule persisted on disk in .copilot/settings.local.json
    const localSettingsPath = join(workDir, '.copilot', 'settings.local.json')
    const persisted = JSON.parse(readFileSync(localSettingsPath, 'utf8')) as {
      permissions?: { allow?: string[] }
    }
    expect(persisted.permissions?.allow).toContain('Edit')

    // Verify live ToolPermissionContext updated immediately
    const allowRules = store.getState().toolPermissionContext.alwaysAllowRules.localSettings ?? []
    expect(allowRules).toContain('Edit')
    inst.unmount()
  })

  test('3-tab /config dialog renders General, Permissions, and Display tabs and switches tabs via Right arrow', () => {
    const { stdout, stdin } = createStreams()
    const inst = render(
      <App>
        <ConfigDialog onClose={() => {}} />
      </App>,
      { stdout, stdin },
    )
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('General')
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Permissions')
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Display')
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Verbose output:')

    // Switch to Permissions tab
    stdin.write('\x1b[C')
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Current mode: default')

    // Switch to Display tab
    stdin.write('\x1b[C')
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Current theme:')
    inst.unmount()
  })

  test('Slash command registry exposes all 4 core command groups, remote/bridge allowlists, Output Styles, and green /doctor', async () => {
    const all = getAllCommands()
    expect(all.length).toBeGreaterThanOrEqual(40)
    for (const name of [
      'clear',
      'resume',
      'branch',
      'rewind',
      'export',
      'copy',
      'btw',
      'exit',
      'model',
      'effort',
      'fast',
      'config',
      'output-style',
      'compact',
      'context',
      'cost',
      'stats',
      'permissions',
      'sandbox',
      'hooks',
      'diff',
      'review',
      'help',
      'status',
      'doctor',
      'theme',
      'vim',
      'commit',
      'version',
    ]) {
      expect(getCommandByName(name)).toBeDefined()
    }

    expect(isRemoteSafeCommand('help')).toBe(true)
    expect(isRemoteSafeCommand('doctor')).toBe(false)
    expect(isBridgeSafeCommand('compact')).toBe(true)

    // Custom project Output Style loading
    const stylesDir = join(workDir, '.copilot', 'output-styles')
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(
      join(stylesDir, 'pirate.md'),
      '---\nname: pirate\ndescription: Speak like a pirate\n---\nRespond with nautical phrasing.\n',
      'utf8',
    )
    const styles = loadOutputStyles({ projectDir: workDir, userConfigDir: join(workDir, 'user-cfg') })
    expect(styles.default).toBeDefined()
    expect(styles.explanatory).toBeDefined()
    expect(styles.pirate?.description).toBe('Speak like a pirate')

    // /doctor diagnostics return green checks
    const report = runDoctorDiagnostics({ cwd: workDir, configDir: join(workDir, 'user-cfg') })
    expect(report.hasFailures).toBe(false)
    expect(report.checks.every(c => c.status !== 'fail')).toBe(true)

    const { stdout, stdin } = createStreams()
    const inst = render(
      <App>
        <Doctor report={report} onDone={() => {}} />
      </App>,
      { stdout, stdin },
    )
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Everything looks healthy!')
    inst.unmount()
  })
})
