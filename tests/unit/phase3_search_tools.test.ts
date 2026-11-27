import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState } from '../../src/state/app_state_store.js'
import type { ToolUseContext } from '../../src/tool.js'
import { GlobTool } from '../../src/tools/glob_tool/glob_tool.js'
import {
  GREP_MAX_RESULT_SIZE_CHARS,
  GrepTool,
} from '../../src/tools/grep_tool/grep_tool.js'
import { extractGlobBaseDirectory } from '../../src/utilities/glob.js'

function makeContext(denyRules: string[] = []): ToolUseContext {
  const base = getDefaultAppState()
  const state = {
    ...base,
    toolPermissionContext: {
      ...base.toolPermissionContext,
      alwaysDenyRules: denyRules.length > 0 ? { userSettings: denyRules } : {},
    },
  }
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => state,
  }
}

describe('Phase 3.3: Search tools (Glob & Grep)', () => {
  let tempDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tempDir = mkdtempSync(join(tmpdir(), 'copilot-p3-search-'))
    setOriginalCwd(tempDir)
    setCwdState(tempDir)

    mkdirSync(join(tempDir, 'src', 'core'), { recursive: true })
    mkdirSync(join(tempDir, 'ignored_dir'), { recursive: true })
    mkdirSync(join(tempDir, 'secret'), { recursive: true })
    writeFileSync(join(tempDir, '.gitignore'), 'ignored_dir/\n*.log\n', 'utf8')
    writeFileSync(
      join(tempDir, 'src', 'core', 'alpha.ts'),
      'export function alpha() {\n  return "HELLO_TOKEN"\n}\n',
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'src', 'core', 'beta.ts'),
      'export const beta = "hello_token"\n// second HELLO_TOKEN line\n',
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'src', 'notes.md'),
      '# Title\nMulti\nLine\nMatch\n',
      'utf8',
    )
    writeFileSync(
      join(tempDir, 'ignored_dir', 'hidden.ts'),
      'export const HELLO_TOKEN = "ignored"\n',
      'utf8',
    )
    writeFileSync(join(tempDir, 'debug.log'), 'HELLO_TOKEN\n', 'utf8')
    writeFileSync(
      join(tempDir, 'secret', 'creds.ts'),
      'export const HELLO_TOKEN = "secret"\n',
      'utf8',
    )
  })

  afterEach(() => {
    setOriginalCwd(prevCwd)
    setCwdState(prevCwd)
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('extractGlobBaseDirectory() narrows static prefix cleanly', () => {
    expect(extractGlobBaseDirectory('src/core/**/*.ts')).toEqual({
      baseDir: 'src/core',
      pattern: '**/*.ts',
    })
    expect(extractGlobBaseDirectory('**/*.ts')).toEqual({
      baseDir: null,
      pattern: '**/*.ts',
    })
  })

  test('GlobTool finds matching files, respects .gitignore and permission deny rules, and truncates at 100 entries', async () => {
    const ctx = makeContext(['Read(secret/**)'])
    const res = await GlobTool.call(
      { pattern: '**/*.ts', path: tempDir },
      ctx,
      undefined,
      undefined,
    )

    expect(res.data.truncated).toBe(false)
    const names = res.data.filenames.map(f => f.replace(/\\/g, '/'))
    expect(names.some(f => f.endsWith('src/core/alpha.ts'))).toBe(true)
    expect(names.some(f => f.endsWith('src/core/beta.ts'))).toBe(true)
    expect(names.some(f => f.includes('ignored_dir'))).toBe(false)
    expect(names.some(f => f.includes('secret/creds.ts'))).toBe(false)

    // Verify 100-entry default truncation cap
    const manyDir = join(tempDir, 'many')
    mkdirSync(manyDir, { recursive: true })
    for (let i = 0; i < 110; i++) {
      writeFileSync(join(manyDir, `file_${String(i).padStart(3, '0')}.txt`), 'ok')
    }
    const capped = await GlobTool.call(
      { pattern: '*.txt', path: manyDir },
      makeContext(),
      undefined,
      undefined,
    )
    expect(capped.data.numFiles).toBe(100)
    expect(capped.data.truncated).toBe(true)
    const block = GlobTool.mapToolResultToToolResultBlockParam(capped.data, 'g1')
    expect(String(block.content)).toContain('truncated')
  })

  test('GrepTool supports files_with_matches, content (with context), count, case-insensitive, multiline, pagination, and 20k cap', async () => {
    expect(GrepTool.maxResultSizeChars).toBe(GREP_MAX_RESULT_SIZE_CHARS)
    expect(GrepTool.maxResultSizeChars).toBe(20_000)

    const ctx = makeContext(['Read(secret/**)'])

    // 1. files_with_matches (default) respecting .gitignore & deny rules
    const filesRes = await GrepTool.call(
      {
        pattern: 'HELLO_TOKEN',
        path: tempDir,
        output_mode: 'files_with_matches',
        '-n': true,
        '-i': false,
        offset: 0,
        multiline: false,
      },
      ctx,
      undefined,
      undefined,
    )
    expect(filesRes.data.filenames.length).toBe(2)
    expect(filesRes.data.filenames.some(f => f.includes('ignored_dir'))).toBe(false)
    expect(filesRes.data.filenames.some(f => f.includes('debug.log'))).toBe(false)
    expect(filesRes.data.filenames.some(f => f.includes('secret'))).toBe(false)

    // 2. content mode with -i and -C context
    const contentRes = await GrepTool.call(
      {
        pattern: 'hello_token',
        path: join(tempDir, 'src'),
        output_mode: 'content',
        '-n': true,
        '-i': true,
        '-C': 1,
        offset: 0,
        multiline: false,
      },
      ctx,
      undefined,
      undefined,
    )
    expect(contentRes.data.content).toContain('alpha.ts')
    expect(contentRes.data.content).toContain('beta.ts')

    // 3. count mode
    const countRes = await GrepTool.call(
      {
        pattern: 'hello_token',
        path: join(tempDir, 'src'),
        output_mode: 'count',
        '-n': true,
        '-i': true,
        offset: 0,
        multiline: false,
      },
      ctx,
      undefined,
      undefined,
    )
    expect(countRes.data.numMatches).toBe(3)

    // 4. multiline search + glob filter
    const multiRes = await GrepTool.call(
      {
        pattern: 'Multi\\nLine\\nMatch',
        path: tempDir,
        glob: '*.md',
        output_mode: 'files_with_matches',
        '-n': true,
        '-i': false,
        offset: 0,
        multiline: true,
      },
      ctx,
      undefined,
      undefined,
    )
    expect(multiRes.data.filenames.length).toBe(1)
    expect(multiRes.data.filenames[0]).toContain('notes.md')

    // 5. head_limit + offset pagination
    const pagedRes = await GrepTool.call(
      {
        pattern: 'HELLO_TOKEN',
        path: tempDir,
        output_mode: 'files_with_matches',
        '-n': true,
        '-i': false,
        head_limit: 1,
        offset: 1,
        multiline: false,
      },
      ctx,
      undefined,
      undefined,
    )
    expect(pagedRes.data.filenames.length).toBe(1)
    expect(pagedRes.data.appliedOffset).toBe(1)
  })
})
