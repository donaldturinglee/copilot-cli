/**
 * Baseline fail-closed read-only shell command classification for Phase 3.
 * Phase 4 layers full `tree-sitter-bash` / PowerShell AST verification on top.
 */

const SIMPLE_READ_ONLY_COMMANDS = new Set([
  'ls',
  'pwd',
  'whoami',
  'date',
  'uname',
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'wc',
  'which',
  'where',
  'type',
  'env',
  'printenv',
  'true',
  'false',
])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'branch',
  'rev-parse',
  'describe',
  'ls-files',
  'blame',
])

const SHELL_METACHARS = /[;&|><`$(){}[\]\n]/

/**
 * Conservatively identifies simple read-only shell commands with no shell
 * metacharacters, redirections, or command substitutions.
 */
export function isSimpleReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed || SHELL_METACHARS.test(trimmed)) {
    return false
  }
  const tokens = trimmed.split(/\s+/)
  const cmd = tokens[0]
  if (!cmd) return false
  if (SIMPLE_READ_ONLY_COMMANDS.has(cmd)) {
    return true
  }
  if (cmd === 'git') {
    const sub = tokens[1]
    if (sub && READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
      if (
        sub === 'branch' &&
        tokens.some(t => t === '-d' || t === '-D' || t === '-m' || t === '-M')
      ) {
        return false
      }
      return true
    }
  }
  return false
}
