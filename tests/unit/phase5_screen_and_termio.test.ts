import { describe, expect, test } from 'bun:test'
import { type AnsiCode, tokenize as ansiTokenize } from '@alcalzone/ansi-tokenize'
import { optimizeDiff } from '../../src/ink/optimizer.js'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
} from '../../src/ink/parse_keypress.js'
import {
  blitRegion,
  cellAt,
  CellWidth,
  createScreen,
  diffEach,
  isSoftWrap,
  markNoSelectRect,
  screenToPlainLines,
  setCell,
  setSoftWrap,
  shiftRows,
  StylePool,
  writeText,
} from '../../src/ink/screen.js'
import {
  createSelectionState,
  getSelectedText,
  startSelection,
  updateSelection,
} from '../../src/ink/selection.js'
import { TerminalQuerier } from '../../src/ink/terminal_querier.js'
import {
  BSU,
  createParser,
  createTokenizer,
  ESU,
  hyperlink,
  PASTE_END,
  PASTE_START,
  PROGRESS_STATE,
  setClipboard,
  setProgress,
} from '../../src/ink/termio.js'

describe('Phase 5.2 — Packed Screen Buffer & Termio Input Protocol', () => {
  test('Screen allocates 8 bytes/cell, interns ASCII/styles/hyperlinks, and enforces StylePool bit-0 VISIBLE_ON_SPACE', () => {
    const screen = createScreen(20, 5)
    expect(screen.cells.byteLength).toBe(20 * 5 * 8)
    expect(screen.cells64.length).toBe(20 * 5)

    const pool = screen.stylePool
    const fgCodes = ansiTokenize('\x1b[32m').filter(
      (t): t is AnsiCode => t.type === 'ansi',
    )
    const bgCodes = ansiTokenize('\x1b[44m').filter(
      (t): t is AnsiCode => t.type === 'ansi',
    )
    const fgId = pool.intern(fgCodes)
    const bgId = pool.intern(bgCodes)

    // Bit 0: even = invisible on space, odd = visible on space
    expect(fgId % 2).toBe(0)
    expect(pool.isVisibleOnSpace(fgId)).toBe(false)
    expect(bgId % 2).toBe(1)
    expect(pool.isVisibleOnSpace(bgId)).toBe(true)

    // Transition cache returns SGR sequence between styles
    const trans = pool.transition(fgId, bgId)
    expect(trans).toContain('\x1b[')
    expect(pool.transition(fgId, bgId)).toBe(trans)
  })

  test('Screen handles CJK/emoji wide characters, orphan cleanup on overwrite, shiftRows, blitRegion, and diffEach', () => {
    const pool = new StylePool()
    const a = createScreen(10, 4, pool)
    const b = createScreen(10, 4, pool, a.charPool, a.hyperlinkPool)

    writeText(a, 0, 0, 'Hi你好!')
    expect(cellAt(a, 2, 0)?.char).toBe('你')
    expect(cellAt(a, 2, 0)?.width).toBe(CellWidth.Wide)
    expect(cellAt(a, 3, 0)?.width).toBe(CellWidth.SpacerTail)
    expect(cellAt(a, 4, 0)?.char).toBe('好')

    // Overwriting SpacerTail of '你' at x=3 must clean up orphaned Wide head at x=2
    setCell(a, 3, 0, 'X', 0, undefined, CellWidth.Narrow)
    expect(cellAt(a, 2, 0)?.char).toBe(' ')
    expect(cellAt(a, 2, 0)?.width).toBe(CellWidth.Narrow)
    expect(cellAt(a, 3, 0)?.char).toBe('X')

    // Blit row 0 into b and diff
    blitRegion(a, b, 0, 0, 10, 1, 0, 0)
    const diffs: string[] = []
    diffEach(a, b, (x, y) => {
      diffs.push(`${x},${y}`)
    })
    expect(diffs.length).toBe(0)

    // Mutate one cell and verify exact diff detection
    setCell(b, 5, 0, 'Z', 0, undefined, CellWidth.Narrow)
    diffEach(a, b, (x, y) => {
      diffs.push(`${x},${y}`)
    })
    expect(diffs).toContain('5,0')

    // shiftRows shifts lines upward cleanly
    writeText(b, 0, 1, 'row1')
    writeText(b, 0, 2, 'row2')
    shiftRows(b, 0, 2, 1)
    expect(screenToPlainLines(b)[0]).toBe('row1')
    expect(screenToPlainLines(b)[1]).toBe('row2')
    expect(screenToPlainLines(b)[2]).toBe('')
  })

  test('Selection extraction skips noSelect columns and joins softWrap lines', () => {
    const screen = createScreen(20, 3)
    writeText(screen, 0, 0, ' 1 | hello ')
    writeText(screen, 0, 1, '   | world')
    writeText(screen, 0, 2, ' 2 | next')
    markNoSelectRect(screen, 0, 0, 5, 3)
    setSoftWrap(screen, 1, true)
    expect(isSoftWrap(screen, 1)).toBe(true)

    const sel = createSelectionState()
    startSelection(sel, 0, 0)
    updateSelection(sel, 19, 2)

    const copied = getSelectedText(sel, screen)
    expect(copied).toBe('helloworld\nnext')
  })

  test('Streaming VT tokenizer & parser decode chunked CSI, OSC 8/52/9;4, and DEC 2026 BSU/ESU', () => {
    const tokenizer = createTokenizer({ x10Mouse: true })
    const seq = `${BSU}${hyperlink('https://example.com', 'docs')}${setClipboard('abc')}${setProgress(PROGRESS_STATE.NORMAL, 65)}${ESU}`

    // Feed 3 characters at a time to stress chunk boundaries
    const parser = createParser()
    const events = []
    for (let i = 0; i < seq.length; i += 3) {
      events.push(...parser.feed(seq.slice(i, i + 3)))
    }
    events.push(...parser.flush())

    expect(events.some(e => e.type === 'syncStart')).toBe(true)
    expect(events.some(e => e.type === 'syncEnd')).toBe(true)
    expect(
      events.some(e => e.type === 'hyperlink' && e.url === 'https://example.com'),
    ).toBe(true)
    expect(
      events.some(
        e => e.type === 'clipboard' && e.data === Buffer.from('abc').toString('base64'),
      ),
    ).toBe(true)
    expect(
      events.some(e => e.type === 'progress' && e.state === 1 && e.percent === 65),
    ).toBe(true)
    expect(tokenizer.buffer()).toBe('')
  })

  test('parseMultipleKeypresses decodes Kitty CSI u, modifyOtherKeys, SGR/X10 mouse, and empty/non-empty Bracketed Paste', () => {
    let state = INITIAL_STATE

    // 1. Kitty Shift+Enter (\x1b[13;2u) & Super+C (\x1b[99;9u)
    let [events, next] = parseMultipleKeypresses(
      state,
      '\x1b[13;2u\x1b[99;9u',
    )
    state = next
    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({
      kind: 'key',
      name: 'return',
      shift: true,
    })
    expect(events[1]).toMatchObject({
      kind: 'key',
      name: 'c',
      super: true,
    })

    // 2. modifyOtherKeys Shift+Enter (\x1b[27;2;13~)
    ;[events, next] = parseMultipleKeypresses(state, '\x1b[27;2;13~')
    state = next
    expect(events[0]).toMatchObject({
      kind: 'key',
      name: 'return',
      shift: true,
    })

    // 3. SGR Mouse press + drag + release + wheel, and X10 mouse
    ;[events, next] = parseMultipleKeypresses(
      state,
      '\x1b[<0;12;5M\x1b[<32;15;5M\x1b[<0;15;5m\x1b[<64;10;10M\x1b[M !"',
    )
    state = next
    expect(events[0]).toMatchObject({
      kind: 'mouse',
      button: 'left',
      action: 'press',
      col: 11,
      row: 4,
    })
    expect(events[1]).toMatchObject({
      kind: 'mouse',
      button: 'left',
      action: 'drag',
      col: 14,
      row: 4,
    })
    expect(events[2]).toMatchObject({
      kind: 'mouse',
      button: 'left',
      action: 'release',
    })
    expect(events[3]).toMatchObject({
      kind: 'mouse',
      button: 'wheelUp',
      action: 'wheel',
    })
    expect(events[4]).toMatchObject({
      kind: 'mouse',
      button: 'left',
      action: 'press',
      col: 0,
      row: 1,
    })

    // 4. Bracketed Paste (text + empty paste signaling clipboard image)
    ;[events, next] = parseMultipleKeypresses(
      state,
      `${PASTE_START}line1\nline2${PASTE_END}${PASTE_START}${PASTE_END}`,
    )
    state = next
    expect(events[0]).toMatchObject({
      kind: 'key',
      isPasted: true,
      isEmptyPaste: false,
      sequence: 'line1\nline2',
    })
    expect(events[1]).toMatchObject({
      kind: 'key',
      isPasted: true,
      isEmptyPaste: true,
      sequence: '',
    })
  })

  test('TerminalQuerier resolves XTVERSION, OSC 11 background theme, DECRQM 2026, and Kitty flags immediately on DA1 fence', async () => {
    const written: string[] = []
    const querier = new TerminalQuerier(seq => written.push(seq))
    const probePromise = querier.probe({ timeoutMs: 500 })

    expect(written.join('')).toContain('\x1b[>0q')
    expect(written.join('')).toContain('\x1b]11;?\x07')
    expect(written.join('')).toContain('\x1b[c')

    const inbound =
      '\x1bP>|ghostty 1.1.0\x1b\\' +
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x07' +
      '\x1b[?2026;2$y' +
      '\x1b[?1u' +
      '\x1b[?62;c'
    const [events] = parseMultipleKeypresses(INITIAL_STATE, inbound)
    for (const ev of events) {
      if (ev.kind === 'response') {
        querier.handleResponse(ev.response)
      }
    }

    const res = await probePromise
    expect(res.timedOut).toBe(false)
    expect(res.xtversion).toBe('ghostty 1.1.0')
    expect(res.detectedTheme).toBe('dark')
    expect(res.supportsSyncOutput).toBe(true)
    expect(res.kittyKeyboardFlags).toBe(1)
    expect(res.da1Params).toEqual([62])
  })

  test('optimizeDiff coalesces adjacent stdout, folds relative moves, and cancels empty/opposite ops', () => {
    const optimized = optimizeDiff([
      { type: 'cursorHide' },
      { type: 'cursorShow' },
      { type: 'cursorMove', x: 3, y: 1 },
      { type: 'cursorMove', x: -3, y: -1 },
      { type: 'stdout', content: 'Hel' },
      { type: 'stdout', content: 'lo' },
      { type: 'stdout', content: '' },
      { type: 'style', styleId: 2 },
      { type: 'style', styleId: 4 },
    ])

    expect(optimized).toEqual([
      { type: 'stdout', content: 'Hello' },
      { type: 'style', styleId: 4 },
    ])
  })
})
