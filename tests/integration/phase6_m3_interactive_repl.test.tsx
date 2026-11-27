import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React, { useState } from 'react'
import { PassThrough } from 'stream'
import {
  resetStateForTests,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import { App } from '../../src/components/app.js'
import { StartupGates } from '../../src/dialog_launchers.js'
import { render } from '../../src/ink/root.js'
import { productionDeps, type QueryDeps } from '../../src/query/deps.js'
import { REPL } from '../../src/screens/repl.js'
import { createAppStateStore } from '../../src/state/app_state_store.js'
import { createAssistantMessage } from '../../src/utilities/messages.js'
import { resetSettingsCache } from '../../src/utilities/settings/settings_cache.js'

function createStreams(columns = 100, rows = 32) {
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

async function waitFor(
  predicate: () => boolean,
  getDebugText?: () => string,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 15))
  }
  const snap = getDebugText ? `\n--- SCREEN ---\n${getDebugText()}\n--------------` : ''
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition${snap}`)
}

describe('Phase 6 M3 Milestone — Interactive End-to-End REPL Flow', () => {
  let workDir: string

  beforeEach(() => {
    resetStateForTests()
    resetSettingsCache()
    setIsInteractive(true)
    workDir = mkdtempSync(join(tmpdir(), 'copilot-p6-m3-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
    writeFileSync(join(workDir, 'hello.ts'), 'export const greeting = "old"\n', 'utf8')
  })

  afterEach(() => {
    resetSettingsCache()
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('passes TrustDialog -> runs multi-turn streaming conversation -> /doctor -> /vim -> !shell -> interactive Edit permission approval -> /exit', async () => {
    const { stdout, stdin } = createStreams()
    const store = createAppStateStore()
    const targetFile = join(workDir, 'hello.ts')
    const historyPath = join(workDir, 'history.jsonl')

    let turnCall = 0
    let exited = false

    const mockDeps: QueryDeps = {
      ...productionDeps(),
      async *callModel() {
        turnCall++
        if (turnCall === 1) {
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hello from streaming Copilot!' },
            },
          }
          yield createAssistantMessage({
            content: 'Hello from streaming Copilot!',
          })
          return
        }
        if (turnCall === 2) {
          // Turn 2 reads hello.ts first (auto-allowed in default mode)
          yield createAssistantMessage({
            content: [
              {
                type: 'tool_use',
                id: 'tu-m3-read',
                name: 'Read',
                input: { file_path: targetFile },
              },
            ],
          })
          return
        }
        if (turnCall === 3) {
          // Turn 3 invokes FileEditTool to trigger interactive permission dialog!
          yield createAssistantMessage({
            content: [
              {
                type: 'tool_use',
                id: 'tu-m3-edit',
                name: 'Edit',
                input: {
                  file_path: targetFile,
                  old_string: 'export const greeting = "old"',
                  new_string: 'export const greeting = "new"',
                },
              },
            ],
          })
          return
        }
        // Turn 4 finishes after FileEditTool ran
        yield createAssistantMessage({
          content: 'Updated greeting to new!',
        })
      },
    }

    function M3App() {
      const [trusted, setTrusted] = useState(false)
      if (!trusted) {
        return (
          <StartupGates
            cwd={workDir}
            skipOnboarding={true}
            persist={false}
            onComplete={() => setTrusted(true)}
            onAbort={() => {
              exited = true
            }}
          />
        )
      }
      return (
        <REPL
          cwd={workDir}
          fullscreen={false}
          queryDeps={mockDeps}
          historyPath={historyPath}
          skipHooks={true}
          bashExecutor={async cmd => ({
            stdout: `shell-ok:${cmd}\n`,
            stderr: '',
            code: 0,
          })}
          onExit={() => {
            exited = true
          }}
        />
      )
    }

    const inst = render(
      <App store={store}>
        <M3App />
      </App>,
      { stdout, stdin },
    )

    // 1. TrustDialog gate appears first
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('Do you trust the files in this folder?')
    stdin.write('\r') // Accept trust (first option)
    inst.flush()

    // 2. REPL welcome chrome renders
    await waitFor(() => inst.ink.getPlainScreenLines().join('\n').includes('Welcome to Copilot CLI'))

    // 3. Submit normal prompt -> verify streamed assistant response
    stdin.write('Say hi')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return inst.ink
          .getPlainScreenLines()
          .join('\n')
          .includes('Hello from streaming Copilot!')
      },
      () => inst.ink.getPlainScreenLines().join('\n'),
    )

    // 4. Execute `/doctor` -> verify healthy green checks -> press Escape to close
    const screen = () => inst.ink.getPlainScreenLines().join('\n')
    stdin.write('/doctor')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('Everything looks healthy!')
      },
      screen,
    )
    stdin.write('\x1b')
    await waitFor(
      () => {
        inst.flush()
        return !screen().includes('Everything looks healthy!')
      },
      screen,
    )

    // 5. Execute `!echo m3` direct shell mode
    stdin.write('!echo m3')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('shell-ok:echo m3')
      },
      screen,
    )

    // 6. Toggle `/vim` on & back off
    stdin.write('/vim on')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('Vim editing mode enabled')
      },
      screen,
    )
    stdin.write('/vim off')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('Vim editing mode disabled')
      },
      screen,
    )

    // 7. Trigger Edit tool in default mode -> interactive PermissionRequest dialog -> Always allow
    stdin.write('Update greeting')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('Yes, always allow Edit tool')
      },
      screen,
    )

    // Select option #3 ("Yes, always allow Edit tool")
    stdin.write('\x1b[B')
    stdin.write('\x1b[B')
    stdin.write('\r')
    await waitFor(
      () => {
        inst.flush()
        return screen().includes('Updated greeting to new!')
      },
      screen,
    )

    // Verify file was genuinely edited & permission rule persisted on disk
    expect(readFileSync(targetFile, 'utf8')).toContain('greeting = "new"')
    const persisted = JSON.parse(
      readFileSync(join(workDir, '.copilot', 'settings.local.json'), 'utf8'),
    ) as { permissions?: { allow?: string[] } }
    expect(persisted.permissions?.allow).toContain('Edit')

    // 8. Exit cleanly via `/exit`
    stdin.write('/exit')
    stdin.write('\r')
    await waitFor(() => exited)
    expect(exited).toBe(true)

    inst.unmount()
  })
})
