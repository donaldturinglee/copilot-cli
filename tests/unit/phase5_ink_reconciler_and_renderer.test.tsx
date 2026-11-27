import { describe, expect, test } from 'bun:test'
import React, { useRef } from 'react'
import { PassThrough } from 'stream'
import {
  AlternateScreen,
  Box,
  ClickEvent,
  createNode,
  dispatchEvent,
  FocusManager,
  Link,
  NoSelect,
  render,
  ScrollBox,
  type ScrollBoxHandle,
  Text,
} from '../../src/ink.js'
import { BSU, ENTER_ALT_SCREEN, ESU, EXIT_ALT_SCREEN } from '../../src/ink/termio/dec.js'
import { renderToScreenSnapshot } from '../../src/utilities/static_render.js'

function createMockTTYStreams(columns = 60, rows = 15) {
  const chunks: string[] = []
  const stdout = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: true,
  })
  stdout.on('data', chunk => {
    chunks.push(chunk.toString('utf8'))
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => {},
  })
  return { stdout, stdin, chunks }
}

describe('Phase 5.3 — React 19 Ink Reconciler, Double-Buffered Rendering & Event/Focus System', () => {
  test('renders Main-Screen and Alt-Screen (DEC 1049 + BSU/ESU) cleanly with double-buffered diffs', () => {
    // 1. Main-screen mode
    const main = createMockTTYStreams(50, 12)
    const mainApp = render(
      <Box flexDirection="column" borderStyle="single">
        <Text bold>Main Screen Header</Text>
        <Text>Body line</Text>
      </Box>,
      { stdout: main.stdout, stdin: main.stdin, altScreen: false },
    )
    expect(mainApp.ink.getPlainScreenLines().join('\n')).toContain(
      'Main Screen Header',
    )
    expect(main.chunks.join('')).toContain(BSU)
    expect(main.chunks.join('')).toContain(ESU)
    expect(main.chunks.join('')).not.toContain(ENTER_ALT_SCREEN)
    mainApp.unmount()

    // 2. Alt-Screen (DEC 1049) mode
    const alt = createMockTTYStreams(50, 12)
    const altApp = render(
      <AlternateScreen>
        <Box flexDirection="column">
          <Text>Alt Screen View</Text>
          <Link url="https://copilot.dev">Copilot Docs</Link>
        </Box>
      </AlternateScreen>,
      { stdout: alt.stdout, stdin: alt.stdin, altScreen: true },
    )
    const initialOut = alt.chunks.join('')
    expect(initialOut).toContain(ENTER_ALT_SCREEN)
    expect(initialOut).toContain(BSU)
    expect(initialOut).toContain(ESU)
    expect(altApp.ink.getPlainScreenLines()[0]).toContain('Alt Screen View')
    expect(altApp.ink.getPlainScreenLines()[1]).toContain('Copilot Docs')

    altApp.unmount()
    expect(alt.chunks.join('')).toContain(EXIT_ALT_SCREEN)
  })

  test('ScrollBox scrolls smoothly at 60fps budget, emits DECSTBM scroll region sequence, and supports drag-selection copy without NoSelect gutter leakage', () => {
    const { stdout, stdin, chunks } = createMockTTYStreams(50, 10)
    let scrollHandle: ScrollBoxHandle | null = null

    function DemoScrollApp() {
      const ref = useRef<ScrollBoxHandle | null>(null)
      scrollHandle = ref.current
      return (
        <AlternateScreen>
          <ScrollBox
            ref={h => {
              ref.current = h
              scrollHandle = h
            }}
            height={6}
            width={40}
          >
            {Array.from({ length: 80 }, (_, i) => (
              <Box key={i} flexDirection="row">
                <NoSelect fromLeftEdge={true}>
                  <Text>{String(i + 1).padStart(2)} | </Text>
                </NoSelect>
                <Text>Row content #{i + 1}</Text>
              </Box>
            ))}
          </ScrollBox>
        </AlternateScreen>
      )
    }

    const inst = render(<DemoScrollApp />, {
      stdout,
      stdin,
      altScreen: true,
      mouse: true,
    })

    expect(scrollHandle).not.toBeNull()
    expect(inst.ink.getPlainScreenLines()[0]).toContain('Row content #1')

    // Scroll down 60 frames and measure per-frame timing
    chunks.length = 0
    const t0 = performance.now()
    for (let step = 1; step <= 60; step++) {
      scrollHandle!.scrollTo(step)
      inst.flush()
    }
    const avgFrameMs = (performance.now() - t0) / 60

    expect(avgFrameMs).toBeLessThan(16.67)
    expect(inst.ink.getPlainScreenLines()[0]).toContain('Row content #61')
    // DECSTBM hardware scroll region sequence emitted (\x1b[1;6r ... \x1b[S)
    expect(chunks.join('')).toContain('\x1b[1;6r')

    // Simulate SGR left-button drag across rows 0..2 including the <NoSelect> gutter
    stdin.write('\x1b[<0;1;1M')
    stdin.write('\x1b[<32;30;3M')
    stdin.write('\x1b[<0;30;3m')

    const selected = inst.ink.getSelectedText()
    expect(selected).toBe('Row content #61\nRow content #62\nRow content #63')
    expect(selected).not.toContain('61 |')

    inst.unmount()
  })

  test('DOM capture/target/bubble event dispatch and 32-level FocusManager stack restoration', () => {
    const root = createNode('ink-root')
    const parent = createNode('ink-box')
    const child = createNode('ink-box')
    parent.parentNode = root
    child.parentNode = parent
    root.childNodes.push(parent)
    parent.childNodes.push(child)

    const order: string[] = []
    root.eventHandlers = {
      onClickCapture: () => order.push('root:capture'),
      onClick: () => order.push('root:bubble'),
    }
    parent.eventHandlers = {
      onClickCapture: () => order.push('parent:capture'),
      onClick: e => {
        order.push('parent:bubble')
        e.stopPropagation()
      },
    }
    child.eventHandlers = {
      onClickCapture: () => order.push('child:capture'),
      onClick: () => order.push('child:bubble'),
    }

    dispatchEvent(
      child,
      new ClickEvent('click', { col: 0, row: 0, button: 'left', action: 'press' }),
    )
    expect(order).toEqual([
      'root:capture',
      'parent:capture',
      'child:capture',
      'child:bubble',
      'parent:bubble',
    ])

    // 32-level focus stack + restoration on removal
    const focusLog: string[] = []
    const fm = new FocusManager((target, ev) => {
      focusLog.push(`${ev.type}:${String(target.attributes['aria-label'])}`)
      return true
    })
    root.focusManager = fm

    const nodes = Array.from({ length: 40 }, (_, i) => {
      const n = createNode('ink-box')
      n.attributes['aria-label'] = `item-${i}`
      n.attributes['tabIndex'] = 0
      n.parentNode = root
      root.childNodes.push(n)
      return n
    })

    for (const n of nodes) fm.focus(n)
    expect(fm.activeElement).toBe(nodes[39]!)
    expect(fm.stackDepth).toBe(32)

    // Removing active node restores previous mounted element from stack
    const last = nodes[39]!
    root.childNodes = root.childNodes.filter(c => c !== last)
    last.parentNode = undefined
    fm.handleNodeRemoved(last, root)
    expect(fm.activeElement).toBe(nodes[38]!)
    expect(focusLog.at(-1)).toBe('focus:item-38')
  })

  test('static_render renders React trees synchronously offscreen', () => {
    const snap = renderToScreenSnapshot(
      <Box flexDirection="column">
        <Text bold color="success">
          Hello Offscreen
        </Text>
      </Box>,
      { columns: 40, rows: 5 },
    )
    expect(snap.plain).toBe('Hello Offscreen')
    expect(snap.ansi).toContain('\x1b[')
  })
})
