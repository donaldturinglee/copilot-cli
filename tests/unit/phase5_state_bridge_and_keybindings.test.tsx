import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React, { useState } from 'react'
import { PassThrough } from 'stream'
import { useDoublePress } from '../../src/hooks/use_double_press.js'
import { useSearchInput } from '../../src/hooks/use_search_input.js'
import { useTerminalSize } from '../../src/hooks/use_terminal_size.js'
import { Box, render, Text, useInput } from '../../src/ink.js'
import { KeybindingSetup } from '../../src/keybindings/keybinding_provider_setup.js'
import {
  loadKeybindingsSyncWithWarnings,
  reloadKeybindingsNow,
  stopKeybindingWatcher,
} from '../../src/keybindings/load_user_bindings.js'
import { useKeybinding } from '../../src/keybindings/use_keybinding.js'
import {
  AppStateProvider,
  useAppState,
  useSetAppState,
} from '../../src/state/app_state.js'
import { createAppStateStore } from '../../src/state/app_state_store.js'
import { Cursor } from '../../src/utilities/cursor.js'

function createTestStreams(columns = 80, rows = 24) {
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

const tempDirs: string[] = []

afterEach(async () => {
  await stopKeybindingWatcher()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Phase 5.4 — AppState React Bridge, Chorded Keybindings & Core UI Hooks', () => {
  test('useAppState(selector) isolates slices so unrelated state mutations do not re-render subscribers', () => {
    const store = createAppStateStore({ verbose: false, fastMode: false })
    let verboseRenders = 0
    let fastModeRenders = 0

    function VerboseView() {
      verboseRenders++
      const verbose = useAppState(s => s.verbose)
      return <Text>verbose:{String(verbose)}</Text>
    }

    function FastModeView() {
      fastModeRenders++
      const fastMode = useAppState(s => s.fastMode)
      const setAppState = useSetAppState()
      void setAppState
      return <Text>fast:{String(fastMode)}</Text>
    }

    const { stdout, stdin } = createTestStreams()
    const inst = render(
      <AppStateProvider store={store}>
        <Box flexDirection="column">
          <VerboseView />
          <FastModeView />
        </Box>
      </AppStateProvider>,
      { stdout, stdin },
    )

    expect(verboseRenders).toBe(1)
    expect(fastModeRenders).toBe(1)

    // Mutate only `verbose` -> FastModeView must NOT re-render
    store.setState(prev => ({ ...prev, verbose: true }))
    inst.flush()
    expect(verboseRenders).toBe(2)
    expect(fastModeRenders).toBe(1)
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('verbose:true')

    // Mutate only `fastMode` -> VerboseView must NOT re-render
    store.setState(prev => ({ ...prev, fastMode: true }))
    inst.flush()
    expect(verboseRenders).toBe(2)
    expect(fastModeRenders).toBe(2)

    inst.unmount()
  })

  test('ChordInterceptor executes ctrl+x ctrl+e with ZERO character leakage into text input and cancels on timeout/Esc', async () => {
    const { stdout, stdin } = createTestStreams()
    let externalEditorCalls = 0
    const leakedChars: string[] = []

    function ChatProbe() {
      useKeybinding(
        'chat:externalEditor',
        () => {
          externalEditorCalls++
        },
        { context: 'Chat' },
      )

      useInput((input, key) => {
        if (!key.ctrl && !key.meta && input) {
          leakedChars.push(input)
        }
      })

      return <Text>Chat active</Text>
    }

    const inst = render(
      <KeybindingSetup chordTimeoutMs={60} enableWatcher={false}>
        <ChatProbe />
      </KeybindingSetup>,
      { stdout, stdin, exitOnCtrlC: false },
    )

    // Press Ctrl+X (0x18) followed by Ctrl+E (0x05)
    stdin.write('\x18')
    stdin.write('\x05')

    expect(externalEditorCalls).toBe(1)
    expect(leakedChars).toEqual([])

    // Press Ctrl+X then wait >60ms for chord timeout, then type 'a' -> 'a' flows normally
    stdin.write('\x18')
    await new Promise(resolve => setTimeout(resolve, 90))
    stdin.write('a')
    expect(leakedChars).toEqual(['a'])

    // Press Ctrl+X then Escape -> chord cancels cleanly without leaking
    stdin.write('\x18')
    stdin.write('\x1b')
    expect(externalEditorCalls).toBe(1)

    inst.unmount()
  })

  test('User keybindings.json supports hot reload and rejects non-rebindable reserved shortcuts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-kb-'))
    tempDirs.push(dir)
    const kbPath = join(dir, 'keybindings.json')

    writeFileSync(
      kbPath,
      JSON.stringify({
        bindings: [
          {
            context: 'Chat',
            bindings: {
              'ctrl+c': 'chat:submit', // reserved non-rebindable -> error
              'ctrl+k ctrl+e': 'chat:externalEditor', // valid custom chord
            },
          },
        ],
      }),
      'utf8',
    )

    const loaded = loadKeybindingsSyncWithWarnings(kbPath)
    expect(
      loaded.warnings.some(
        w => w.type === 'reserved_shortcut' && w.severity === 'error' && w.key === 'ctrl+c',
      ),
    ).toBe(true)
    expect(
      loaded.bindings.some(
        b => b.source === 'user' && b.action === 'chat:externalEditor',
      ),
    ).toBe(true)

    // Mount KeybindingSetup and verify hot reload propagates updated binding
    const { stdout, stdin } = createTestStreams()
    let customTriggered = 0

    function Probe() {
      useKeybinding(
        'chat:externalEditor',
        () => {
          customTriggered++
        },
        { context: 'Chat' },
      )
      return <Text>ok</Text>
    }

    const inst = render(
      <KeybindingSetup enableWatcher={false} keybindingsPath={kbPath}>
        <Probe />
      </KeybindingSetup>,
      { stdout, stdin, exitOnCtrlC: false },
    )

    // Hot-reload with new chord `ctrl+k ctrl+o`
    writeFileSync(
      kbPath,
      JSON.stringify({
        bindings: [
          {
            context: 'Chat',
            bindings: {
              'ctrl+k ctrl+o': 'chat:externalEditor',
            },
          },
        ],
      }),
      'utf8',
    )
    reloadKeybindingsNow(kbPath)
    inst.flush()

    // Trigger ctrl+k (0x0b) ctrl+o (0x0f)
    stdin.write('\x0b')
    stdin.write('\x0f')
    expect(customTriggered).toBe(1)

    inst.unmount()
  })

  test('Grapheme-aware Cursor handles emoji clusters, multi-line navigation, and readline edits', () => {
    let cur = Cursor.fromText('hi 👨‍👩‍👧‍👦 ok\nsecond line', 80)
    expect(cur.getPosition()).toEqual({ line: 1, column: 11 })

    cur = cur.up()
    expect(cur.getPosition().line).toBe(0)

    cur = cur.startOfLine().right().right().right() // right before family emoji
    const afterEmoji = cur.right()
    expect(afterEmoji.offset - cur.offset).toBe('👨‍👩‍👧‍👦'.length)
    expect(afterEmoji.backspace().text).toBe('hi  ok\nsecond line')

    const wordDeleted = Cursor.fromText('alpha beta').deleteWordBefore()
    expect(wordDeleted.text).toBe('alpha ')
  })

  test('useDoublePress, useSearchInput, and useTerminalSize resize updates work cleanly', () => {
    const { stdout, stdin } = createTestStreams(80, 24)
    let confirmed = 0
    let submitted = ''

    function HookDemo() {
      const size = useTerminalSize()
      const dp = useDoublePress(() => confirmed++, undefined, 500)
      const search = useSearchInput({
        onSubmit: q => {
          submitted = q
        },
      })
      const [ticks, setTicks] = useState(0)
      useInput((input, key) => {
        if (key.ctrl && input === 'q') {
          dp.trigger()
          setTicks(t => t + 1)
        }
      })
      return (
        <Text>
          {size.columns}x{size.rows}|{search.query}|{String(dp.pending)}|{ticks}
        </Text>
      )
    }

    const inst = render(<HookDemo />, { stdout, stdin })
    expect(inst.ink.getPlainScreenLines()[0]).toContain('80x24||false')

    // Type search query and submit
    stdin.write('foo\r')
    inst.flush()
    expect(submitted).toBe('foo')

    // Double press Ctrl+Q (0x11)
    stdin.write('\x11')
    inst.flush()
    expect(confirmed).toBe(0)
    stdin.write('\x11')
    inst.flush()
    expect(confirmed).toBe(1)

    // Resize stdout and emit resize event
    stdout.columns = 100
    stdout.rows = 30
    stdout.emit('resize')
    inst.flush()
    expect(inst.ink.getPlainScreenLines()[0]).toContain('100x30')

    inst.unmount()
  })
})
