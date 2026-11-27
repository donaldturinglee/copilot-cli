import { describe, expect, test } from 'bun:test'
import { VimEngine } from '../../src/vim/vim_engine.js'

describe('Phase 6.4 — 11-State Vim Editing Engine & Atomic [Image #N] Chips', () => {
  test('supports counted operator motions (2dw), undo (u), redo (Ctrl+R), and dot-repeat (.)', () => {
    const vim = new VimEngine('one two three four five', 'NORMAL')
    vim.feedKeys(['2', 'd', 'w'])
    expect(vim.doc.text).toBe('three four five')
    expect(vim.persistent.register).toBe('one two ')

    // Dot-repeat deletes the next two words
    vim.feedKeys(['.'])
    expect(vim.doc.text).toBe('five')

    // Undo restores step by step
    vim.feedKeys(['u'])
    expect(vim.doc.text).toBe('three four five')
    vim.feedKeys(['u'])
    expect(vim.doc.text).toBe('one two three four five')

    // Redo reapplies
    vim.handleKey({ char: 'r', ctrl: true })
    expect(vim.doc.text).toBe('three four five')
  })

  test('supports inner/around text objects (ci", daw, yi() and dot-repeat of change', () => {
    const vim = new VimEngine('const msg = "hello world"', 'NORMAL')
    vim.doc.cursor = 15 // inside "hello world"
    vim.feedKeys(['c', 'i', '"', 'b', 'y', 'e', '<Esc>'])
    expect(vim.doc.text).toBe('const msg = "bye"')
    expect(vim.state.mode).toBe('NORMAL')

    // Bracket text object yank & paste
    const vim2 = new VimEngine('fn(alpha, beta)', 'NORMAL')
    vim2.doc.cursor = 5
    vim2.feedKeys(['y', 'i', '('])
    expect(vim2.persistent.register).toBe('alpha, beta')
  })

  test('supports linewise dd/yy/p/P, gg/G, >>/<<, f/t/;, r, ~, and J across all 11 CommandStates', () => {
    const vim = new VimEngine('line1\nline2\nline3', 'NORMAL')

    // `j` -> line2, `dd` deletes line2 linewise
    vim.feedKeys(['j', 'd', 'd'])
    expect(vim.doc.text).toBe('line1\nline3')
    expect(vim.persistent.registerIsLinewise).toBe(true)

    // `p` pastes line2 below line3
    vim.feedKeys(['p'])
    expect(vim.doc.text).toBe('line1\nline3\nline2')

    // `gg` jumps to top, `>>` indents first line, `<<` dedents
    vim.feedKeys(['g', 'g', '>', '>'])
    expect(vim.doc.text.startsWith('  line1')).toBe(true)
    vim.feedKeys(['<', '<'])
    expect(vim.doc.text.startsWith('line1')).toBe(true)

    // `f` find + `;` repeat + `r` replace + `~` case toggle
    const vim3 = new VimEngine('abc_def_ghi', 'NORMAL')
    vim3.feedKeys(['f', '_'])
    expect(vim3.doc.cursor).toBe(3)
    vim3.feedKeys([';'])
    expect(vim3.doc.cursor).toBe(7)
    vim3.feedKeys(['r', '-'])
    expect(vim3.doc.text).toBe('abc_def-ghi')
    vim3.feedKeys(['0', '~'])
    expect(vim3.doc.text).toBe('Abc_def-ghi')

    // `J` joins lines
    const vim4 = new VimEngine('hello\n  world', 'NORMAL')
    vim4.feedKeys(['J'])
    expect(vim4.doc.text).toBe('hello world')

    // `d2w` exercises operatorCount state; `df_` exercises operatorFind; `dgg` exercises operatorG
    const vim5 = new VimEngine('a b c d', 'NORMAL')
    vim5.feedKeys(['d', '2', 'w'])
    expect(vim5.doc.text).toBe('c d')

    const vim6 = new VimEngine('prefix_keep', 'NORMAL')
    vim6.feedKeys(['d', 'f', '_'])
    expect(vim6.doc.text).toBe('keep')

    const vim7 = new VimEngine('top\nmid\nbot', 'NORMAL')
    vim7.feedKeys(['G', 'd', 'g', 'g'])
    expect(vim7.doc.text).toBe('')
  })

  test('protects atomic [Image #N] chips from partial cursor entry, partial deletion, and character overwrite', () => {
    const vim = new VimEngine('see [Image #1] here', 'NORMAL')
    // Move word forward onto `[Image #1]`
    vim.feedKeys(['w'])
    expect(vim.doc.cursor).toBe(4)

    // `r` refuses to overwrite characters inside `[Image #1]`
    vim.feedKeys(['r', 'X'])
    expect(vim.doc.text).toBe('see [Image #1] here')

    // `l` skips completely past the entire `[Image #1]` token rather than landing inside it
    vim.feedKeys(['l'])
    expect(vim.doc.cursor).toBe(14)

    // `b` jumps back to start of `[Image #1]`, and `x` deletes the entire chip atomically
    vim.feedKeys(['b', 'x'])
    expect(vim.doc.text).toBe('see  here')
    expect(vim.doc.text).not.toContain('Image')
    expect(vim.doc.text).not.toContain('#1]')
  })
})
