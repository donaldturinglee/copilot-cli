import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, normalize } from 'path'
import { setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../src/state/app_state_store.js'
import type { ToolUseContext } from '../../src/tool.js'
import { BashTool } from '../../src/tools/bash_tool/bash_tool.js'
import { PowerShellTool } from '../../src/tools/power_shell_tool/power_shell_tool.js'
import { rearrangePipeCommand } from '../../src/utilities/bash/bash_pipe_command.js'
import { formatShellPrefixCommand } from '../../src/utilities/bash/shell_prefix.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
} from '../../src/utilities/bash/shell_quoting.js'
import { getCwd } from '../../src/utilities/cwd.js'
import { ShellError } from '../../src/utilities/errors.js'
import { findSuitableShell } from '../../src/utilities/shell.js'
import { findPowerShell } from '../../src/utilities/shell/powershell_detection.js'
import { buildPowerShellArgs } from '../../src/utilities/shell/powershell_provider.js'

function createCtx(): ToolUseContext {
  let state = getDefaultAppState()
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

describe('Phase 3.4: Cross-platform shell runtime, BashTool, and PowerShellTool', () => {
  let tempDir: string
  let subDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p3-shell-'))
    subDir = join(tempDir, 'sub_folder')
    mkdirSync(subDir, { recursive: true })
    setOriginalCwd(tempDir)
    setCwdState(tempDir)
  })

  afterEach(() => {
    setOriginalCwd(prevCwd)
    setCwdState(prevCwd)
    rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    })
  })

  test('shell quoting, pipe rearrangement, prefix, null redirect, and PowerShell args work cleanly', () => {
    expect(quoteShellCommand("echo 'hi'")).toBe("'echo '\\''hi'\\'''")
    expect(rearrangePipeCommand('echo a | cat')).toBe('{ echo a | cat\n} < /dev/null')
    expect(rearrangePipeCommand('cat < file.txt')).toBe('cat < file.txt')
    expect(formatShellPrefixCommand('timeout 10', 'echo hi')).toBe(
      "timeout 10 'echo hi'",
    )
    expect(rewriteWindowsNullRedirect('cmd 2>/dev/null')).toBe('cmd 2>NUL')

    const encodedArgs = buildPowerShellArgs('Write-Output 42', { encoded: true })
    expect(encodedArgs.slice(0, 3)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ])
    expect(Buffer.from(encodedArgs[3]!, 'base64').toString('utf16le')).toBe(
      'Write-Output 42',
    )
  })

  test(
    'BashTool captures stdout/stderr, persists CWD across commands, handles non-zero exit codes, and runs background tasks',
    async () => {
      if (!findSuitableShell()) {
        return
      }

      const ctx = createCtx()

      // 1. stdout + stderr capture
      const echoRes = await BashTool.call(
        { command: 'echo hello_out && echo hello_err >&2' },
        ctx,
        undefined,
        undefined,
      )
      expect(echoRes.data.stdout).toContain('hello_out')
      expect(echoRes.data.stderr).toContain('hello_err')
      expect(echoRes.data.interrupted).toBe(false)

      // 2. CWD persistence across sequential commands
      await BashTool.call({ command: 'cd sub_folder' }, ctx, undefined, undefined)
      expect(normalize(getCwd()).toLowerCase()).toBe(
        normalize(subDir).toLowerCase(),
      )

      // 3. Non-zero exit code throws ShellError
      let caught: unknown
      try {
        await BashTool.call(
          { command: 'echo fail_msg >&2; exit 7' },
          ctx,
          undefined,
          undefined,
        )
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ShellError)
      expect((caught as ShellError).code).toBe(7)
      expect((caught as ShellError).stderr).toContain('fail_msg')

      // 4. Background execution registers local_bash task and completes asynchronously
      const bgRes = await BashTool.call(
        { command: 'echo bg_done', run_in_background: true },
        ctx,
        undefined,
        undefined,
      )
      const bgId = bgRes.data.backgroundTaskId!
      expect(bgId).toBeTruthy()
      expect(bgRes.data.backgroundTaskOutputPath).toBeTruthy()
      expect(ctx.getAppState?.().tasks[bgId]?.type).toBe('local_bash')

      const deadline = Date.now() + 5_000
      while (
        ctx.getAppState?.().tasks[bgId]?.status === 'running' &&
        Date.now() < deadline
      ) {
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(ctx.getAppState?.().tasks[bgId]?.status).toBe('completed')
    },
    15_000,
  )

  test(
    'BashTool enforces timeout termination and kills process tree',
    async () => {
      if (!findSuitableShell()) {
        return
      }

      const ctx = createCtx()
      let timeoutCaught: unknown
      try {
        await BashTool.call(
          { command: 'sleep 10', timeout: 300 },
          ctx,
          undefined,
          undefined,
        )
      } catch (err) {
        timeoutCaught = err
      }
      expect(timeoutCaught).toBeInstanceOf(ShellError)
      expect((timeoutCaught as ShellError).interrupted).toBe(true)
      expect((timeoutCaught as ShellError).stderr).toContain('timed out')
    },
    15_000,
  )

  test('PowerShellTool executes commands and persists CWD when PowerShell is available', async () => {
    if (!findPowerShell()) {
      return
    }
    const ctx = createCtx()
    const res = await PowerShellTool.call(
      { command: 'Write-Output "ps_ok"; [Console]::Error.WriteLine("ps_err")' },
      ctx,
      undefined,
      undefined,
    )
    expect(res.data.stdout).toContain('ps_ok')
    expect(res.data.stderr).toContain('ps_err')

    await PowerShellTool.call(
      { command: 'Set-Location sub_folder' },
      ctx,
      undefined,
      undefined,
    )
    expect(normalize(getCwd()).toLowerCase()).toBe(
      normalize(subDir).toLowerCase(),
    )
  })
})
