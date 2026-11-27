import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import type { ToolUseContext } from '../../src/tool.js'
import { FileEditTool } from '../../src/tools/file_edit_tool/file_edit_tool.js'
import { FileReadTool } from '../../src/tools/file_read_tool/file_read_tool.js'
import { FileWriteTool } from '../../src/tools/file_write_tool/file_write_tool.js'
import { NotebookEditTool } from '../../src/tools/notebook_edit_tool/notebook_edit_tool.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
} from '../../src/utilities/file_state_cache.js'
import { parsePdfPageRange } from '../../src/utilities/pdf_utils.js'

// Valid 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

function createContext(
  readFileState = createFileStateCacheWithSizeLimit(),
): ToolUseContext {
  return {
    abortController: new AbortController(),
    messages: [],
    readFileState,
  }
}

describe('Phase 3.2: FileStateCache and File I/O tools (Read, Edit, Write, NotebookEdit)', () => {
  let tempDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p3-io-'))
    setOriginalCwd(tempDir)
    setCwdState(tempDir)
  })

  afterEach(() => {
    setOriginalCwd(prevCwd)
    setCwdState(prevCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('FileStateCache supports path normalization, LRU eviction, clone, and merge', () => {
    const cache = createFileStateCacheWithSizeLimit(10_000, 2)
    cache.set(join(tempDir, 'a.txt'), { content: 'a', timestamp: 100 })
    cache.set(join(tempDir, 'b.txt'), { content: 'b', timestamp: 200 })
    cache.set(join(tempDir, 'c.txt'), { content: 'c', timestamp: 300 })

    expect(cache.size).toBe(2)
    expect(cache.has(join(tempDir, 'a.txt'))).toBe(false)
    expect(cache.has(join(tempDir, 'c.txt'))).toBe(true)

    const cloned = cloneFileStateCache(cache)
    cloned.set(join(tempDir, 'b.txt'), { content: 'b-newer', timestamp: 500 })
    const merged = mergeFileStateCaches(cache, cloned)
    expect(merged.get(join(tempDir, 'b.txt'))?.content).toBe('b-newer')
  })

  test('FileReadTool reads line-numbered text, supports offset/limit pagination, and deduplicates unchanged re-reads', async () => {
    const file = join(tempDir, 'lines.txt')
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`)
    writeFileSync(file, lines.join('\n') + '\n', 'utf8')

    const ctx = createContext()

    // Full read
    const res1 = await FileReadTool.call({ file_path: file }, ctx, undefined, undefined)
    expect(res1.data.type).toBe('text')
    if (res1.data.type === 'text') {
      expect(res1.data.file.numLines).toBe(50)
      expect(res1.data.file.totalLines).toBe(50)
    }
    const block1 = FileReadTool.mapToolResultToToolResultBlockParam(res1.data, 't1')
    expect(String(block1.content)).toContain('1\tline-1')
    expect(String(block1.content)).toContain('50\tline-50')

    // Unchanged full re-read returns file_unchanged stub
    const res2 = await FileReadTool.call({ file_path: file }, ctx, undefined, undefined)
    expect(res2.data.type).toBe('file_unchanged')

    // Paginated read
    const res3 = await FileReadTool.call(
      { file_path: file, offset: 11, limit: 5 },
      ctx,
      undefined,
      undefined,
    )
    expect(res3.data.type).toBe('text')
    if (res3.data.type === 'text') {
      expect(res3.data.file.startLine).toBe(11)
      expect(res3.data.file.numLines).toBe(5)
      expect(res3.data.file.content).toBe('line-11\nline-12\nline-13\nline-14\nline-15')
    }
    expect(ctx.readFileState?.get(file)?.isPartialView).toBe(true)
  })

  test('FileReadTool guards blocking devices, UNC paths, binary files, and reads PNG images & PDF range validation', async () => {
    const ctx = createContext()

    const devCheck = await FileReadTool.validateInput!(
      { file_path: '/dev/zero' },
      ctx,
    )
    expect(devCheck.result).toBe(false)

    const uncCheck = await FileReadTool.validateInput!(
      { file_path: '\\\\evil-server\\share\\file.txt' },
      ctx,
    )
    expect(uncCheck.result).toBe(false)

    const binFile = join(tempDir, 'archive.zip')
    writeFileSync(binFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const binCheck = await FileReadTool.validateInput!(
      { file_path: binFile },
      ctx,
    )
    expect(binCheck.result).toBe(false)

    const pngFile = join(tempDir, 'pixel.png')
    writeFileSync(pngFile, TINY_PNG)
    const imgRes = await FileReadTool.call({ file_path: pngFile }, ctx, undefined, undefined)
    expect(imgRes.data.type).toBe('image')
    if (imgRes.data.type === 'image') {
      expect(imgRes.data.file.type).toBe('image/png')
      expect(imgRes.data.file.dimensions?.originalWidth).toBe(1)
      expect(imgRes.data.file.dimensions?.originalHeight).toBe(1)
    }

    expect(parsePdfPageRange('1-5')).toEqual({ ok: true, range: { start: 1, end: 5 } })
    expect(parsePdfPageRange('1-25').ok).toBe(false)
    expect(parsePdfPageRange('5-2').ok).toBe(false)
  })

  test('FileEditTool enforces read-before-edit, rejects partial reads, detects external modifications, and handles curly quotes & replace_all', async () => {
    const file = join(tempDir, 'code.ts')
    writeFileSync(file, 'const greeting = \u201Chello\u201D\nconst x = 1\nconst y = 1\n', 'utf8')
    const ctx = createContext()

    // 1. Reject unread file
    const unread = await FileEditTool.validateInput!(
      { file_path: file, old_string: 'const x = 1', new_string: 'const x = 2', replace_all: false },
      ctx,
    )
    expect(unread.result).toBe(false)
    if (!unread.result) expect(unread.message).toContain('not been read')

    // 2. Reject partial read
    await FileReadTool.call({ file_path: file, offset: 1, limit: 1 }, ctx, undefined, undefined)
    const partial = await FileEditTool.validateInput!(
      { file_path: file, old_string: 'const x = 1', new_string: 'const x = 2', replace_all: false },
      ctx,
    )
    expect(partial.result).toBe(false)
    if (!partial.result) expect(partial.message).toContain('partially read')

    // 3. Full read -> external modification conflict
    await FileReadTool.call({ file_path: file }, ctx, undefined, undefined)
    writeFileSync(file, 'const greeting = \u201Chello\u201D\nconst x = 999\nconst y = 1\n', 'utf8')
    const future = new Date(Date.now() + 10_000)
    utimesSync(file, future, future)

    const stale = await FileEditTool.validateInput!(
      { file_path: file, old_string: 'const y = 1', new_string: 'const y = 2', replace_all: false },
      ctx,
    )
    expect(stale.result).toBe(false)
    if (!stale.result) expect(stale.message).toContain('modified since read')

    // 4. Re-read -> curly-quote normalization & preservation
    await FileReadTool.call({ file_path: file }, ctx, undefined, undefined)
    const curlyEditValid = await FileEditTool.validateInput!(
      { file_path: file, old_string: '"hello"', new_string: '"world"', replace_all: false },
      ctx,
    )
    expect(curlyEditValid.result).toBe(true)
    await FileEditTool.call(
      { file_path: file, old_string: '"hello"', new_string: '"world"', replace_all: false },
      ctx,
      undefined,
      undefined,
    )
    expect(readFileSync(file, 'utf8')).toContain('\u201Cworld\u201D')

    // 5. Multiple matches rejected when replace_all is false, allowed when true
    const dupRes = await FileEditTool.validateInput!(
      { file_path: file, old_string: 'const ', new_string: 'let ', replace_all: false },
      ctx,
    )
    expect(dupRes.result).toBe(false)
    const replaceAllRes = await FileEditTool.call(
      { file_path: file, old_string: 'const ', new_string: 'let ', replace_all: true },
      ctx,
      undefined,
      undefined,
    )
    expect(replaceAllRes.data.replaceAll).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('const ')

    // 6. .ipynb guard redirects to NotebookEdit
    const nbPath = join(tempDir, 'demo.ipynb')
    const nbGuard = await FileEditTool.validateInput!(
      { file_path: nbPath, old_string: 'a', new_string: 'b', replace_all: false },
      ctx,
    )
    expect(nbGuard.result).toBe(false)
    if (!nbGuard.result) expect(nbGuard.message).toContain('NotebookEdit')

    // 7. backfillObservableInput expands relative paths
    const observable: Record<string, unknown> = { file_path: 'code.ts' }
    FileEditTool.backfillObservableInput!(observable)
    expect(observable.file_path).toBe(file)
  })

  test('FileWriteTool creates nested files and enforces read-before-overwrite on existing files', async () => {
    const ctx = createContext()
    const nestedFile = join(tempDir, 'nested', 'dir', 'new.txt')

    // New file succeeds without prior read
    expect(
      (await FileWriteTool.validateInput!({ file_path: nestedFile, content: 'hello' }, ctx))
        .result,
    ).toBe(true)
    const created = await FileWriteTool.call(
      { file_path: nestedFile, content: 'hello' },
      ctx,
      undefined,
      undefined,
    )
    expect(created.data.type).toBe('create')
    expect(readFileSync(nestedFile, 'utf8')).toBe('hello')

    // Fresh context without readFileState rejects overwrite
    const freshCtx = createContext()
    const denied = await FileWriteTool.validateInput!(
      { file_path: nestedFile, content: 'overwrite' },
      freshCtx,
    )
    expect(denied.result).toBe(false)

    // Original context already recorded readFileState on create -> overwrite allowed
    const updated = await FileWriteTool.call(
      { file_path: nestedFile, content: 'updated' },
      ctx,
      undefined,
      undefined,
    )
    expect(updated.data.type).toBe('update')
    expect(readFileSync(nestedFile, 'utf8')).toBe('updated')
  })

  test('NotebookEditTool supports replace, insert, and delete on .ipynb files', async () => {
    const nbPath = join(tempDir, 'analysis.ipynb')
    const initialNotebook = {
      cells: [
        {
          cell_type: 'code',
          id: 'c1',
          source: 'x = 1',
          metadata: {},
          execution_count: 5,
          outputs: [{ output_type: 'stream', name: 'stdout', text: '1\n' }],
        },
        {
          cell_type: 'markdown',
          id: 'c2',
          source: '# Notes',
          metadata: {},
        },
      ],
      metadata: { language_info: { name: 'python' } },
      nbformat: 4,
      nbformat_minor: 5,
    }
    writeFileSync(nbPath, JSON.stringify(initialNotebook, null, 1), 'utf8')
    const ctx = createContext()

    // Read notebook via FileReadTool first
    const readRes = await FileReadTool.call({ file_path: nbPath }, ctx, undefined, undefined)
    expect(readRes.data.type).toBe('notebook')
    if (readRes.data.type === 'notebook') {
      expect(readRes.data.file.cells.length).toBe(2)
    }

    // Replace code cell (must reset outputs and execution_count)
    await NotebookEditTool.call(
      {
        notebook_path: nbPath,
        cell_id: 'c1',
        new_source: 'x = 42',
        edit_mode: 'replace',
      },
      ctx,
      undefined,
      undefined,
    )
    let parsed = JSON.parse(readFileSync(nbPath, 'utf8'))
    expect(parsed.cells[0].source).toBe('x = 42')
    expect(parsed.cells[0].execution_count).toBeNull()
    expect(parsed.cells[0].outputs).toEqual([])

    // Insert markdown cell after c1 (nbformat 4.5 generates id)
    const inserted = await NotebookEditTool.call(
      {
        notebook_path: nbPath,
        cell_id: 'c1',
        cell_type: 'markdown',
        new_source: '## Inserted',
        edit_mode: 'insert',
      },
      ctx,
      undefined,
      undefined,
    )
    expect(inserted.data.cell_id).toBeTruthy()
    parsed = JSON.parse(readFileSync(nbPath, 'utf8'))
    expect(parsed.cells.length).toBe(3)
    expect(parsed.cells[1].source).toBe('## Inserted')

    // Delete cell c2 via synthetic cell-2 index
    await NotebookEditTool.call(
      {
        notebook_path: nbPath,
        cell_id: 'cell-2',
        new_source: '',
        edit_mode: 'delete',
      },
      ctx,
      undefined,
      undefined,
    )
    parsed = JSON.parse(readFileSync(nbPath, 'utf8'))
    expect(parsed.cells.length).toBe(2)
  })
})
