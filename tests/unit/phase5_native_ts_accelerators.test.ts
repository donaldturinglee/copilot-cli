import { describe, expect, test } from 'bun:test'
import { stripAnsi } from '../../src/ink/string_width.js'
import {
  ansi256FromRgb,
  ColorDiff,
  ColorFile,
  getSyntaxTheme,
  type Hunk,
} from '../../native/color_diff/index.js'
import { FileIndex } from '../../native/file_index/index.js'
import {
  Align,
  Display,
  Edge,
  FlexDirection,
  getYogaCounters,
  Gutter,
  Justify,
  PositionType,
  Wrap,
  YOGA_INSTANCE,
} from '../../native/yoga_layout/index.js'
import { sliceAnsi } from '../../src/utilities/slice_ansi.js'
import { truncate } from '../../src/utilities/truncate.js'

describe('Phase 5.1 — Pure-TS Acceleration Libraries', () => {
  test('Yoga flexbox layout computes row/column, flexGrow, gap, padding, absolute, and display:none/contents', () => {
    const root = YOGA_INSTANCE.Node.create()
    root.setWidth(100)
    root.setHeight(40)
    root.setFlexDirection(FlexDirection.Row)
    root.setPadding(Edge.All, 2)
    root.setGap(Gutter.Column, 4)

    const left = YOGA_INSTANCE.Node.create()
    left.setWidth(20)

    const right = YOGA_INSTANCE.Node.create()
    right.setFlexGrow(1)

    const hidden = YOGA_INSTANCE.Node.create()
    hidden.setWidth(50)
    hidden.setDisplay(Display.None)

    const badge = YOGA_INSTANCE.Node.create()
    badge.setPositionType(PositionType.Absolute)
    badge.setPosition(Edge.Right, 1)
    badge.setPosition(Edge.Top, 1)
    badge.setWidth(10)
    badge.setHeight(2)

    root.insertChild(left, 0)
    root.insertChild(right, 1)
    root.insertChild(hidden, 2)
    root.insertChild(badge, 3)

    root.calculateLayout(100, 40)

    expect(left.getComputedLayout()).toMatchObject({
      left: 2,
      top: 2,
      width: 20,
      height: 36,
    })
    // Inner width = 96; left=20 + gap=4 => right gets 72
    expect(right.getComputedLayout()).toMatchObject({
      left: 26,
      top: 2,
      width: 72,
      height: 36,
    })
    expect(hidden.getComputedWidth()).toBe(0)
    expect(badge.getComputedLayout()).toMatchObject({
      left: 89,
      top: 1,
      width: 10,
      height: 2,
    })

    // Wrap layout test
    const wrapBox = YOGA_INSTANCE.Node.create()
    wrapBox.setWidth(30)
    wrapBox.setFlexDirection(FlexDirection.Row)
    wrapBox.setFlexWrap(Wrap.Wrap)
    wrapBox.setJustifyContent(Justify.FlexStart)
    wrapBox.setAlignItems(Align.FlexStart)
    for (let i = 0; i < 4; i++) {
      const item = YOGA_INSTANCE.Node.create()
      item.setWidth(12)
      item.setHeight(2)
      wrapBox.insertChild(item, i)
    }
    wrapBox.calculateLayout(30, undefined)
    expect(wrapBox.getComputedHeight()).toBe(4) // 2 items per row -> 2 rows

    root.freeRecursive()
    wrapBox.freeRecursive()
  })

  test('Yoga 4-slot Float64Array cache accelerates dirty-leaf relayout on 1,000-node tree to millisecond scale', () => {
    const root = YOGA_INSTANCE.Node.create()
    root.setWidth(120)
    root.setFlexDirection(FlexDirection.Column)

    const leaves: ReturnType<typeof YOGA_INSTANCE.Node.create>[] = []
    for (let row = 0; row < 200; row++) {
      const container = YOGA_INSTANCE.Node.create()
      container.setFlexDirection(FlexDirection.Row)
      container.setPadding(Edge.Horizontal, 1)
      for (let col = 0; col < 4; col++) {
        const leaf = YOGA_INSTANCE.Node.create()
        leaf.setFlexGrow(1)
        leaf.setMeasureFunc(w => ({ width: Math.min(20, w || 20), height: 1 }))
        container.insertChild(leaf, col)
        leaves.push(leaf)
      }
      root.insertChild(container, row)
    }

    const t0 = performance.now()
    root.calculateLayout(120, undefined)
    const initialMs = performance.now() - t0
    expect(root.getComputedHeight()).toBe(200)

    // Dirty a single leaf and recompute — clean siblings should cache-hit
    leaves[500]!.setHeight(2)
    const t1 = performance.now()
    root.calculateLayout(120, undefined)
    const relayoutMs = performance.now() - t1
    const counters = getYogaCounters()

    expect(root.getComputedHeight()).toBe(201)
    expect(counters.cacheHits).toBeGreaterThan(150)
    expect(initialMs).toBeLessThan(150)
    expect(relayoutMs).toBeLessThan(50)

    root.freeRecursive()
  })

  test('ColorDiff & ColorFile render syntax-highlighted inline word diffs and RGB->256 quantization', () => {
    expect(ansi256FromRgb(0, 0, 0)).toBe(16)
    expect(ansi256FromRgb(255, 255, 255)).toBe(231)
    expect(ansi256FromRgb(128, 128, 128)).toBeGreaterThanOrEqual(232)

    expect(getSyntaxTheme('dark').theme).toBe('Monokai Extended')
    expect(getSyntaxTheme('light').theme).toBe('GitHub')
    expect(getSyntaxTheme('dark-ansi').theme).toBe('ansi')

    const hunk: Hunk = {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 3,
      lines: [
        ' export function greet(name: string) {',
        '-  return `Hello ${name}`',
        '+  return `Welcome ${name}!`',
        ' }',
      ],
    }

    const renderedDark = new ColorDiff(hunk, null, 'src/greet.ts').render(
      'dark',
      80,
      false,
    )
    expect(renderedDark).not.toBeNull()
    expect(renderedDark!.length).toBe(4)
    expect(renderedDark![1]).toContain('\x1b[')
    expect(stripAnsi(renderedDark![1]!)).toContain('11')
    expect(stripAnsi(renderedDark![2]!)).toContain('Welcome')

    const renderedLightDaltonized = new ColorDiff(
      hunk,
      null,
      'src/greet.ts',
    ).render('light-daltonized', 80, false)
    expect(renderedLightDaltonized).not.toBeNull()
    expect(renderedLightDaltonized!.length).toBe(4)

    const fileLines = new ColorFile(
      'const x: number = 42\nconsole.log(x)\n',
      'demo.ts',
    ).render('dark', 60, false)
    expect(fileLines).not.toBeNull()
    expect(fileLines!.length).toBe(2)
    expect(fileLines![0]).toContain('\x1b[')
    expect(stripAnsi(fileLines![0]!)).toContain('const x: number = 42')
  })

  test('FileIndex indexes 100,000+ paths via 4ms time-sliced async indexing and fuzzy searches in milliseconds', async () => {
    const filePaths: string[] = []
    const dirs = ['src', 'packages', 'apps', 'libs', 'services', 'tests']
    const subs = ['core', 'ink', 'tools', 'hooks', 'components', 'utilities', 'state']
    for (let i = 0; i < 100_500; i++) {
      const d = dirs[i % dirs.length]!
      const s = subs[(i >> 3) % subs.length]!
      filePaths.push(`${d}/${s}/module_${i}.ts`)
    }
    filePaths.push('src/ink/reconciler.ts')
    filePaths.push('tests/unit/ink/reconciler.test.ts')

    const index = new FileIndex()
    const { queryable, done } = index.loadFromFileListAsync(filePaths)
    await queryable
    expect(index.size()).toBeGreaterThan(0)

    await done
    expect(index.size()).toBe(filePaths.length)

    const t0 = performance.now()
    const results = index.search('inkrec', 10)
    const searchMs = performance.now() - t0

    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0]!.path).toBe('src/ink/reconciler.ts')
    // Test path receives 1.05x score penalty relative to non-test paths
    const testEntry = results.find(r => r.path.includes('tests/'))
    expect(testEntry).toBeDefined()
    expect(searchMs).toBeLessThan(100)

    // Empty query returns top-level directory segments
    const topLevel = index.search('', 5)
    expect(topLevel.length).toBeGreaterThan(0)
  })

  test('sliceAnsi & truncate preserve ANSI styles and handle CJK widths cleanly', () => {
    const styled = '\x1b[31mHello 世界!\x1b[39m'
    const sliced = sliceAnsi(styled, 0, 8) // "Hello 世" = 6 + 2 = 8 cols
    expect(stripAnsi(sliced)).toBe('Hello 世')
    expect(sliced).toContain('\x1b[31m')

    expect(stripAnsi(truncate('Hello World Example', 10))).toBe('Hello Wor…')
    expect(stripAnsi(truncate('abcdefghij', 6, { position: 'middle' }))).toBe(
      'abc…ij',
    )
  })
})
