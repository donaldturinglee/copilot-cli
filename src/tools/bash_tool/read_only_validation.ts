/**
 * Granular read-only Bash command & flag allowlist validation.
 *
 * SECURITY PROPERTIES:
 * - Fail-closed AST parsing (`parseForSecurityFromAst`) MUST return `simple`
 *   with zero file-writing redirects (except `/dev/null` and fd dupes).
 * - Every subcommand in a pipeline or compound list MUST be individually
 *   validated against per-command flag allowlists.
 * - Bare-repo guard: refuses to auto-allow `git` if the current working
 *   directory is a bare git repository (defending against `core.fsmonitor` /
 *   hook execution on `git status`).
 */

import {
  parseForSecurityFromAst,
  type SimpleCommand,
} from '../../utilities/bash/ast.js'
import { isCurrentDirectoryBareGitRepo } from '../../utilities/git.js'
import { sedCommandIsAllowedByAllowlist } from './sed_validation.js'

const DANGEROUS_GIT_GLOBAL_FLAGS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--upload-pack',
  '--receive-pack',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'describe',
  'ls-files',
  'ls-tree',
  'blame',
  'shortlog',
  'rev-list',
  'show-ref',
  'for-each-ref',
  'name-rev',
  'merge-base',
  'cat-file',
  'diff-tree',
  'diff-index',
  'grep',
  'branch',
  'tag',
  'remote',
  'config',
])

const GIT_BRANCH_MUTATION_FLAGS = new Set([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '--set-upstream-to',
  '-u',
  '--unset-upstream',
  '--edit-description',
])

const GIT_TAG_MUTATION_FLAGS = new Set([
  '-a',
  '--annotate',
  '-s',
  '--sign',
  '-u',
  '--local-user',
  '-f',
  '--force',
  '-d',
  '--delete',
  '-m',
  '-F',
])

const GIT_EXEC_FLAGS = new Set([
  '--ext-diff',
  '--textconv',
  '--output',
  '-o',
])

const SIMPLE_READ_ONLY_COMMANDS = new Set([
  'ls',
  'pwd',
  'whoami',
  'id',
  'date',
  'uname',
  'hostname',
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'which',
  'where',
  'type',
  'diff',
  'cmp',
  'comm',
  'uniq',
  'cut',
  'tr',
  'paste',
  'fold',
  'fmt',
  'column',
  'nl',
  'od',
  'hexdump',
  'xxd',
  'strings',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'cksum',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'du',
  'df',
  'free',
  'uptime',
  'ps',
  'env',
  'printenv',
  'true',
  'false',
  'tree',
  'grep',
  'egrep',
  'fgrep',
  'ag',
])

const FIND_DANGEROUS_FLAGS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprintf',
  '-fprint0',
  '-fls',
])

const FD_DANGEROUS_FLAGS = new Set([
  '-x',
  '--exec',
  '-X',
  '--exec-batch',
  '-l',
  '--list-details',
])

const SORT_DANGEROUS_FLAGS = new Set(['-o', '--output', '--compress-program'])

const RG_DANGEROUS_FLAGS = new Set(['--pre', '--pre-glob'])

const SAFE_XARGS_TARGETS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'ls',
  'stat',
  'file',
  'grep',
  'rg',
  'echo',
  'basename',
  'dirname',
  'md5sum',
  'sha256sum',
])

function isSafeGitReadOnly(argv: readonly string[]): boolean {
  if (isCurrentDirectoryBareGitRepo()) {
    return false
  }

  let i = 1
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg === '-C') {
      i += 2
      continue
    }
    if (arg === '--no-pager' || arg === '--no-optional-locks' || arg === '--paginate' || arg === '-P') {
      i++
      continue
    }
    if (
      DANGEROUS_GIT_GLOBAL_FLAGS.has(arg) ||
      arg.startsWith('-c') ||
      arg.startsWith('--config-env=') ||
      arg.startsWith('--exec-path=') ||
      arg.startsWith('--git-dir=') ||
      arg.startsWith('--work-tree=')
    ) {
      return false
    }
    if (arg.startsWith('-')) {
      return false
    }
    break
  }

  const sub = argv[i]
  if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
    return false
  }

  const subArgs = argv.slice(i + 1)

  for (const a of subArgs) {
    if (
      GIT_EXEC_FLAGS.has(a) ||
      a.startsWith('--output=') ||
      a.startsWith('--upload-pack=')
    ) {
      return false
    }
  }

  if (sub === 'branch') {
    const positionals: string[] = []
    for (const a of subArgs) {
      if (GIT_BRANCH_MUTATION_FLAGS.has(a) || a.startsWith('--set-upstream-to=')) {
        return false
      }
      if (!a.startsWith('-')) {
        positionals.push(a)
      }
    }
    // `git branch new-branch` creates a branch! Only allow flag-only or `--list`
    if (positionals.length > 0 && !subArgs.includes('--list') && !subArgs.includes('-l')) {
      return false
    }
    return true
  }

  if (sub === 'tag') {
    const positionals: string[] = []
    for (const a of subArgs) {
      if (GIT_TAG_MUTATION_FLAGS.has(a)) return false
      if (!a.startsWith('-')) positionals.push(a)
    }
    if (positionals.length > 0 && !subArgs.includes('-l') && !subArgs.includes('--list')) {
      return false
    }
    return true
  }

  if (sub === 'remote') {
    const firstSub = subArgs[0]
    return (
      firstSub === undefined ||
      firstSub === '-v' ||
      firstSub === '--verbose' ||
      firstSub === 'show' ||
      firstSub === 'get-url'
    )
  }

  if (sub === 'config') {
    return subArgs.some(
      a =>
        a === '--get' ||
        a === '--get-all' ||
        a === '--list' ||
        a === '-l' ||
        a === '--show-origin',
    ) && !subArgs.some(
      a =>
        a === '--unset' ||
        a === '--unset-all' ||
        a === '--add' ||
        a === '--replace-all' ||
        a === '--edit' ||
        a === '-e',
    )
  }

  return true
}

function isSafeSingleSimpleCommand(cmd: SimpleCommand): boolean {
  // Reject commands with file-writing redirects (only allow `/dev/null` or `2>&1`)
  for (const redir of cmd.redirects) {
    if (redir.op === '<') {
      // Input redirection from arbitrary files still passes through read checks
      continue
    }
    if (redir.target === '/dev/null') {
      continue
    }
    if (redir.op === '>&' && /^\d+$/.test(redir.target)) {
      continue
    }
    return false
  }

  if (cmd.argv.length === 0) return false
  const bin = cmd.argv[0]!.split('/').pop() ?? cmd.argv[0]!
  const args = cmd.argv.slice(1)

  if (bin === 'git') {
    return isSafeGitReadOnly(cmd.argv)
  }

  if (bin === 'find') {
    return !args.some(a => FIND_DANGEROUS_FLAGS.has(a))
  }

  if (bin === 'fd' || bin === 'fdfind') {
    return !args.some(
      a =>
        FD_DANGEROUS_FLAGS.has(a) ||
        a.startsWith('--exec=') ||
        a.startsWith('--exec-batch='),
    )
  }

  if (bin === 'rg') {
    return !args.some(
      a =>
        RG_DANGEROUS_FLAGS.has(a) ||
        a.startsWith('--pre=') ||
        a.startsWith('--pre-glob='),
    )
  }

  if (bin === 'sort') {
    return !args.some(
      a =>
        SORT_DANGEROUS_FLAGS.has(a) ||
        a.startsWith('-o') ||
        a.startsWith('--output=') ||
        a.startsWith('--compress-program='),
    )
  }

  if (bin === 'sed') {
    return sedCommandIsAllowedByAllowlist(cmd.text)
  }

  if (bin === 'jq') {
    if (/\bsystem\s*\(/.test(cmd.text)) return false
    if (
      args.some(
        a =>
          a === '-f' ||
          a === '--from-file' ||
          a === '--argfile' ||
          a === '--rawfile' ||
          a === '--slurpfile' ||
          a.startsWith('--from-file='),
      )
    ) {
      return false
    }
    return true
  }

  if (bin === 'xargs') {
    // Reject deprecated GNU optional-attached `-i` / `-e` and require a safe target command
    let i = 0
    while (i < args.length) {
      const a = args[i]!
      if (a === '-i' || a === '-e' || /^-[a-zA-Z]*[ie]/.test(a)) {
        return false
      }
      if (a === '-I' || a === '-E' || a === '-n' || a === '-P' || a === '-L' || a === '-s' || a === '-d') {
        i += 2
        continue
      }
      if (a.startsWith('-')) {
        if (!/^-[0trx]+$/.test(a)) return false
        i++
        continue
      }
      break
    }
    const target = args[i]
    return target !== undefined && SAFE_XARGS_TARGETS.has(target)
  }

  if (SIMPLE_READ_ONLY_COMMANDS.has(bin)) {
    return true
  }

  return false
}

/**
 * Returns `true` ONLY if the entire Bash command parses cleanly via the
 * fail-closed AST parser AND every simple subcommand is in the read-only
 * allowlist with no dangerous flags or file-writing redirections.
 */
export async function isReadOnlyBashCommandAsync(
  command: string,
): Promise<boolean> {
  const parsed = await parseForSecurityFromAst(command)
  if (parsed.kind !== 'simple') {
    return false
  }
  return parsed.commands.every(isSafeSingleSimpleCommand)
}
