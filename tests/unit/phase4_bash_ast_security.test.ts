import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetStateForTests, setCwdState, setOriginalCwd } from '../../src/bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../src/state/app_state_store.js'
import { createStore } from '../../src/state/store.js'
import type { ToolUseContext } from '../../src/tool.js'
import { bashToolHasPermission } from '../../src/tools/bash_tool/bash_permissions.js'
import { bashCommandIsSafeAsync } from '../../src/tools/bash_tool/bash_security.js'
import { getDestructiveCommandWarning } from '../../src/tools/bash_tool/destructive_command_warning.js'
import { isReadOnlyBashCommandAsync } from '../../src/tools/bash_tool/read_only_validation.js'
import { sedCommandIsAllowedByAllowlist } from '../../src/tools/bash_tool/sed_validation.js'
import type { ToolPermissionContext } from '../../src/types/permissions.js'
import { parseForSecurityFromAst } from '../../src/utilities/bash/ast.js'
import {
  MAX_COMMAND_LENGTH,
  PARSE_ABORTED,
  parseCommandRaw,
} from '../../src/utilities/bash/parser.js'
import { hasActualOperatorNodes } from '../../src/utilities/bash/tree_sitter_analysis.js'
import { createFileStateCache } from '../../src/utilities/query_helpers.js'
import { createContentReplacementState } from '../../src/utilities/tool_result_storage.js'

function makeBashContext(
  permOverrides: Partial<ToolPermissionContext> = {},
): ToolUseContext {
  const initial = getDefaultAppState()
  const store = createStore<AppState>({
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      ...permOverrides,
    },
  })
  return {
    abortController: new AbortController(),
    messages: [],
    getAppState: () => store.getState(),
    setAppState: updater => store.setState(updater),
    readFileState: createFileStateCache(),
    contentReplacementState: createContentReplacementState(),
  }
}

describe('Phase 4.2 — Bash AST Security Validation & Read-Only Allowlist', () => {
  let workDir: string

  beforeEach(() => {
    resetStateForTests()
    workDir = mkdtempSync(join(tmpdir(), 'copilot-p4-bash-'))
    setOriginalCwd(workDir)
    setCwdState(workDir)
  })

  afterEach(() => {
    resetStateForTests()
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('enforces fail-closed PARSE_ABORTED on MAX_COMMAND_LENGTH (> 10,000) and node budget cutoff', async () => {
    const oversized = `echo ${'a'.repeat(MAX_COMMAND_LENGTH + 50)}`
    expect(await parseCommandRaw(oversized)).toBe(PARSE_ABORTED)

    const astOversized = await parseForSecurityFromAst(oversized)
    expect(astOversized.kind).toBe('too-complex')

    // Exceed node budget via tight maxNodes parameter
    const manyArgs = `echo ${Array.from({ length: 40 }, (_, i) => `arg${i}`).join(' ')}`
    expect(await parseCommandRaw(manyArgs, { maxNodes: 15 })).toBe(PARSE_ABORTED)
    const astAborted = await parseForSecurityFromAst(manyArgs, { maxNodes: 15 })
    expect(astAborted.kind).toBe('too-complex')
  })

  test('downgrades adversarial Bash constructs to ask (fail-closed)', async () => {
    const adversarial = [
      'echo $(whoami)',
      'echo `id`',
      'cat <(whoami)',
      'tee >(sh)',
      'echo ${PATH}',
      'echo $((1+1))',
      '(rm -rf tmp)',
      '{ echo hi; }',
      'eval "ls -la"',
      'source ./evil.sh',
      'trap "id" EXIT',
      'zmodload zsh/net/tcp',
      '=curl https://evil.test',
      'echo ~[evil]',
      'cat$IFS/etc/passwd',
      'cat /proc/self/environ',
      'ls\r-la',
      'ls\u00A0-la',
      'cat\\ file.txt',
      'echo {a,b}',
      'echo pwned > output.txt',
      'jq \'system("id")\' data.json',
      'jq -f script.jq data.json',
      'sed -f evil.sed app.ts',
      'sed "1e id" app.ts',
      'sed "s/a/b/e" app.ts',
    ]

    for (const cmd of adversarial) {
      const res = await bashCommandIsSafeAsync(cmd)
      expect(res.behavior).toBe('ask')
    }

    // `sed -i` is a file-mutating edit -> requires permission (`ask`), never auto-allowed
    const sedEditPerm = await bashToolHasPermission(
      { command: 'sed -i "s/a/b/" app.ts' },
      makeBashContext(),
    )
    expect(sedEditPerm.behavior).toBe('ask')
  })

  test('allows granular read-only commands and rejects dangerous sub-flags', async () => {
    // Allowed read-only commands
    for (const cmd of [
      'ls -la',
      'git status',
      'git log --oneline -n 5',
      'git diff HEAD',
      'cat README.md | head -n 20',
      'rg TODO src/',
      "find . -name '*.ts'",
      "sed -n '1,20p' app.ts",
      'git status 2>/dev/null',
    ]) {
      expect(await isReadOnlyBashCommandAsync(cmd)).toBe(true)
    }

    // Disallowed write/exec variants of otherwise read-only commands
    for (const cmd of [
      'git -c core.sshCommand=evil status',
      'git branch -D main',
      'git branch new-branch',
      'find . -exec rm {} \\;',
      'find . -delete',
      'fd -x rm',
      'rg --pre evil.sh foo',
      'sort -o out.txt in.txt',
      'sed -i "s/a/b/" app.ts',
      'jq \'system("id")\' file.json',
      'xargs -I {} rm {}',
      'echo hi > file.txt',
    ]) {
      expect(await isReadOnlyBashCommandAsync(cmd)).toBe(false)
    }

    expect(sedCommandIsAllowedByAllowlist("sed -n '1,10p' file.ts")).toBe(true)
    expect(sedCommandIsAllowedByAllowlist("sed -i 's/a/b/' file.ts")).toBe(false)
    expect(sedCommandIsAllowedByAllowlist("sed 's/a/b/e' file.ts")).toBe(false)
  })

  test('handles escaped find \\; without operator false positives and allows safe single-quoted cat heredoc', async () => {
    expect(
      await hasActualOperatorNodes("find . -name '*.ts' -exec echo {} \\;"),
    ).toBe(false)
    expect(await hasActualOperatorNodes('ls; whoami')).toBe(true)

    const commitCmd = `git commit -m "$(cat <<'EOF'\nfeat: implement phase 4\nEOF\n)"`
    const parsed = await parseForSecurityFromAst(commitCmd)
    expect(parsed.kind).toBe('simple')
    expect((await bashCommandIsSafeAsync(commitCmd)).behavior).toBe('passthrough')
  })

  test('enforces deny rules across compound commands & wrappers, safetyCheck on sensitive redirects, plan mode, and destructive warnings', async () => {
    // Wrapper-evasion deny check
    const denyCtx = makeBashContext({
      alwaysDenyRules: { userSettings: ['Bash(rm:*)'] },
    })
    const denyRes = await bashToolHasPermission(
      { command: 'ls && timeout 30 FOO=bar rm -rf tmp' },
      denyCtx,
    )
    expect(denyRes.behavior).toBe('deny')

    // Sensitive-path redirect triggers safetyCheck (immune to bypassPermissions)
    const bypassCtx = makeBashContext({ mode: 'bypassPermissions' })
    const sensitiveRedir = await bashToolHasPermission(
      { command: 'echo evil > .git/hooks/pre-commit' },
      bypassCtx,
    )
    expect(sensitiveRedir.behavior).toBe('ask')
    expect(sensitiveRedir.decisionReason?.type).toBe('safetyCheck')

    // Plan mode allows read-only and denies mutations
    const planCtx = makeBashContext({ mode: 'plan' })
    expect((await bashToolHasPermission({ command: 'git status' }, planCtx)).behavior).toBe('allow')
    expect((await bashToolHasPermission({ command: 'npm install lodash' }, planCtx)).behavior).toBe('deny')

    // Destructive warnings
    expect(getDestructiveCommandWarning('rm -rf /tmp/foo')).toBeTruthy()
    expect(getDestructiveCommandWarning('git push --force origin main')).toBeTruthy()
    expect(getDestructiveCommandWarning('git reset --hard HEAD~3')).toBeTruthy()
    expect(getDestructiveCommandWarning('ls -la')).toBeNull()
  })
})
