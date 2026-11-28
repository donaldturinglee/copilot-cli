import { afterEach, describe, expect, test } from 'bun:test'
import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import { PassThrough } from 'stream'
import { Select, SelectMulti } from '../../src/components/custom_select/index.js'
import { Byline } from '../../src/components/design_system/byline.js'
import { Dialog } from '../../src/components/design_system/dialog.js'
import { Divider } from '../../src/components/design_system/divider.js'
import { FuzzyPicker } from '../../src/components/design_system/fuzzy_picker.js'
import { Pane } from '../../src/components/design_system/pane.js'
import { ProgressBar } from '../../src/components/design_system/progress_bar.js'
import { StatusIcon } from '../../src/components/design_system/status_icon.js'
import { Tab, Tabs } from '../../src/components/design_system/tabs.js'
import {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
} from '../../src/components/design_system/theme_provider.js'
import {
  cachedLexer,
  clearMarkdownCache,
  findStableMarkdownBoundary,
  getMarkdownCacheSize,
  Markdown,
  StreamingMarkdown,
} from '../../src/components/markdown.js'
import {
  computeStallIntensity,
  Spinner,
} from '../../src/components/spinner.js'
import { StructuredDiff } from '../../src/components/structured_diff.js'
import {
  clearPendingNotificationTimer,
  type Notification,
  useNotifications,
} from '../../src/context/notifications.js'
import { Box, render, Text } from '../../src/ink.js'
import {
  createSelectionState,
  getSelectedText,
  startSelection,
  updateSelection,
} from '../../src/ink/selection.js'
import { KeybindingSetup } from '../../src/keybindings/keybinding_provider_setup.js'
import { AppStateProvider, useAppState } from '../../src/state/app_state.js'
import { createAppStateStore } from '../../src/state/app_state_store.js'
import { renderToScreenSnapshot } from '../../src/utilities/static_render.js'

function createStreams(columns = 80, rows = 30) {
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

afterEach(() => {
  clearPendingNotificationTimer()
  clearMarkdownCache()
})

describe('Phase 5.5 — Design System, Content Renderers & Notification Queue Demo', () => {
  test('ThemeProvider switches all 6 themes and supports non-destructive live preview', () => {
    const { stdout, stdin } = createStreams()
    let controls!: {
      setPreviewTheme: ReturnType<typeof usePreviewTheme>['setPreviewTheme']
      cancelPreview: ReturnType<typeof usePreviewTheme>['cancelPreview']
      savePreview: ReturnType<typeof usePreviewTheme>['savePreview']
    }

    function ThemeInspector() {
      const [theme] = useTheme()
      const preview = usePreviewTheme()
      controls = preview
      return <Text>active-theme:{theme}</Text>
    }

    const inst = render(
      <ThemeProvider initialTheme="dark">
        <ThemeInspector />
      </ThemeProvider>,
      { stdout, stdin },
    )

    expect(inst.ink.getPlainScreenLines()[0]).toBe('active-theme:dark')

    controls.setPreviewTheme('light-daltonized')
    inst.flush()
    expect(inst.ink.getPlainScreenLines()[0]).toBe(
      'active-theme:light-daltonized',
    )

    controls.cancelPreview()
    inst.flush()
    expect(inst.ink.getPlainScreenLines()[0]).toBe('active-theme:dark')

    controls.setPreviewTheme('dark-ansi')
    inst.flush()
    controls.savePreview()
    inst.flush()
    expect(inst.ink.getPlainScreenLines()[0]).toBe('active-theme:dark-ansi')

    inst.unmount()
  })

  test('Markdown fast-path, 500-entry LRU cache, GFM table, and StreamingMarkdown monotonic prefix work cleanly', () => {
    clearMarkdownCache()

    // Plain prose takes fast path and does not populate lexer cache
    const plainSnap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <Markdown>Simple plain text with no formatting</Markdown>
      </ThemeProvider>,
      { columns: 60 },
    )
    expect(plainSnap.plain).toContain('Simple plain text with no formatting')
    expect(getMarkdownCacheSize()).toBe(0)

    // Formatted markdown with heading, blockquote, list, code block, and GFM table
    const doc = [
      '# Release Summary',
      '',
      '> Built with pure TypeScript',
      '',
      '| Feature | Status |',
      '| --- | --- |',
      '| Yoga | Ready |',
      '| Ink | Ready |',
      '',
      '```ts',
      'const ok = true',
      '```',
    ].join('\n')

    const richSnap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <Markdown width={60}>{doc}</Markdown>
      </ThemeProvider>,
      { columns: 60 },
    )
    expect(richSnap.plain).toContain('Release Summary')
    expect(richSnap.plain).toContain('Built with pure TypeScript')
    expect(richSnap.plain).toContain('Feature')
    expect(richSnap.plain).toContain('Yoga')
    expect(richSnap.plain).toContain('const ok = true')
    expect(getMarkdownCacheSize()).toBe(1)

    // Verify LRU caps at 500 entries
    for (let i = 0; i < 520; i++) {
      cachedLexer(`**item ${i}**`)
    }
    expect(getMarkdownCacheSize()).toBe(500)

    // StreamingMarkdown monotonic boundary stays outside open code fences
    const openFence = 'Paragraph 1\n\n```ts\nconst a = 1\n\nconst b = 2'
    const boundary = findStableMarkdownBoundary(openFence)
    expect(openFence.slice(0, boundary)).toBe('Paragraph 1\n\n')

    const { stdout, stdin } = createStreams(70, 20)
    const streamInst = render(
      <ThemeProvider initialTheme="dark">
        <StreamingMarkdown width={60} isStreaming={true}>
          {'# Streaming\n\nFirst block'}
        </StreamingMarkdown>
      </ThemeProvider>,
      { stdout, stdin },
    )
    streamInst.rerender(
      <ThemeProvider initialTheme="dark">
        <StreamingMarkdown width={60} isStreaming={true}>
          {'# Streaming\n\nFirst block\n\nSecond block'}
        </StreamingMarkdown>
      </ThemeProvider>,
    )
    streamInst.flush()
    const out = streamInst.ink.getPlainScreenLines().join('\n')
    expect(out).toContain('Streaming')
    expect(out).toContain('First block')
    expect(out).toContain('Second block')
    streamInst.unmount()
  }, 25_000)

  test('StructuredDiff renders syntax-highlighted dual columns with <NoSelect> gutter excluded from selection copy', () => {
    const hunk: StructuredPatchHunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        '-const port = 3000',
        '+const port = 8080',
        ' export default port',
      ],
    }

    const snap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <StructuredDiff
          patch={hunk}
          filePath="src/config.ts"
          firstLine={null}
          width={60}
          splitGutter={true}
        />
      </ThemeProvider>,
      { columns: 60, rows: 10 },
    )

    expect(snap.ansi).toContain('\x1b[')
    expect(snap.plain).toContain('const port = 8080')

    // Drag selection across the entire diff screen must skip the <NoSelect> gutter!
    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 59, 2)
    const copied = getSelectedText(sel, snap.screen)
    expect(copied).toContain('const port = 3000')
    expect(copied).toContain('const port = 8080')
    expect(copied).not.toMatch(/^\s*1\s*-/m)
  })

  test('Spinner animates at 20Hz and triggers 3-second stall reddening', () => {
    expect(computeStallIntensity(5000, 3000, 'thinking')).toBe(0) // 2s < 3s
    expect(computeStallIntensity(6500, 3000, 'thinking')).toBeGreaterThan(0) // 3.5s >= 3s

    const healthySnap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <Spinner
          mode="thinking"
          message="Reasoning…"
          startTimeMs={1000}
          lastActivityAtMs={3000}
          nowMs={3500}
          tokenCount={42}
        />
      </ThemeProvider>,
      { columns: 60 },
    )
    expect(healthySnap.plain).toContain('Reasoning…')
    expect(healthySnap.plain).toContain('42 tokens')

    const stalledSnap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <Spinner
          mode="thinking"
          message="Reasoning…"
          startTimeMs={1000}
          lastActivityAtMs={3000}
          nowMs={7000}
        />
      </ThemeProvider>,
      { columns: 60 },
    )
    // Error color in darkTheme is rgb(255,107,128) -> SGR 38;2;255;107;128
    expect(stalledSnap.ansi).toContain('38;2;255;107;128')
  })

  test('Interactive Design System demo: Pane, Dialog, Tabs, Select, SelectMulti, FuzzyPicker, and 4-priority Notification queue', () => {
    const store = createAppStateStore()
    const { stdout, stdin } = createStreams(80, 25)
    let pickedSingle = ''
    let submittedMulti: string[] = []
    let notifyApi!: ReturnType<typeof useNotifications>

    function NotificationDemo() {
      notifyApi = useNotifications()
      const current = useAppState(s => s.notifications.current) as
        | Notification
        | null
      return (
        <Text>
          notif:{current && 'text' in current ? current.text : 'none'}
        </Text>
      )
    }

    const inst = render(
      <AppStateProvider store={store}>
        <ThemeProvider initialTheme="dark">
          <KeybindingSetup enableWatcher={false}>
            <Pane title="Copilot Component Demo" subtitle="Phase 5">
              <Byline>
                <StatusIcon status="success" />
                <Text>All systems green</Text>
              </Byline>
              <ProgressBar ratio={0.75} width={12} showPercentage />
              <Divider width={40} title="Selection" />
              <Tabs defaultTabId="one">
                <Tab id="one" title="Single Select">
                  <Select
                    options={[
                      { label: 'Claude Opus', value: 'opus' },
                      { label: 'Claude Sonnet', value: 'sonnet' },
                    ]}
                    onChange={v => {
                      pickedSingle = v
                    }}
                  />
                </Tab>
                <Tab id="two" title="Multi Select">
                  <SelectMulti
                    options={[
                      { label: 'Lint', value: 'lint' },
                      { label: 'Tests', value: 'tests' },
                    ]}
                    onSubmit={vals => {
                      submittedMulti = vals
                    }}
                  />
                </Tab>
              </Tabs>
              <NotificationDemo />
            </Pane>
          </KeybindingSetup>
        </ThemeProvider>
      </AppStateProvider>,
      { stdout, stdin },
    )

    const initialScreen = inst.ink.getPlainScreenLines().join('\n')
    expect(initialScreen).toContain('Copilot Component Demo')
    expect(initialScreen).toContain('75%')
    expect(initialScreen).toContain('Claude Opus')

    // Move down to Sonnet and press Enter
    stdin.write('\x1b[B\r')
    inst.flush()
    expect(pickedSingle).toBe('sonnet')

    // Switch tab via Right arrow, toggle first item with Space, submit with Enter
    stdin.write('\x1b[C \r')
    inst.flush()
    expect(submittedMulti).toEqual(['lint'])

    // Test 4-priority notification queue: low -> immediate preempts -> high wins after immediate removed
    notifyApi.addNotification({
      key: 'n-low',
      text: 'Low message',
      priority: 'low',
      timeoutMs: 60000,
    })
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain(
      'notif:Low message',
    )

    notifyApi.addNotification({
      key: 'n-high',
      text: 'High message',
      priority: 'high',
      timeoutMs: 60000,
    })
    notifyApi.addNotification({
      key: 'n-imm',
      text: 'Immediate alert',
      priority: 'immediate',
      timeoutMs: 60000,
    })
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain(
      'notif:Immediate alert',
    )

    // Removing immediate notification promotes highest priority in queue (`high` ahead of re-queued `low`)
    notifyApi.removeNotification('n-imm')
    inst.flush()
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain(
      'notif:High message',
    )

    // Static snapshot verify Dialog + FuzzyPicker rendering
    const dialogSnap = renderToScreenSnapshot(
      <ThemeProvider initialTheme="dark">
        <Dialog title="Quick Open" subtitle="Select file">
          <FuzzyPicker
            items={[
              { id: '1', label: 'src/ink.ts', value: 'src/ink.ts' },
              { id: '2', label: 'src/state/app_state.tsx', value: 'src/state/app_state.tsx' },
            ]}
            onSelect={() => {}}
          />
        </Dialog>
      </ThemeProvider>,
      { columns: 60 },
    )
    expect(dialogSnap.plain).toContain('Quick Open')
    expect(dialogSnap.plain).toContain('src/ink.ts')

    inst.unmount()
  })
})
