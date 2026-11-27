/**
 * Destructive shell command warning detector for permission prompts and UX.
 */

interface DestructiveRule {
  pattern: RegExp
  warning: string
}

const DESTRUCTIVE_RULES: readonly DestructiveRule[] = [
  {
    pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)*-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r|\brm\s+-r\s+-f|\brm\s+-f\s+-r/,
    warning: 'Permanently deletes files recursively without confirmation (rm -rf)',
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b)/,
    warning: 'Force-pushes git history and may overwrite remote commits',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    warning: 'Discards all uncommitted local changes permanently (git reset --hard)',
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    warning: 'Permanently deletes untracked workspace files (git clean -f)',
  },
  {
    pattern: /\bgit\s+(?:checkout|restore)\s+--\s+\./,
    warning: 'Overwrites all local working-tree modifications',
  },
  {
    pattern: /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i,
    warning: 'Irreversibly drops or truncates database objects',
  },
  {
    pattern: /\b(?:mkfs(?:\.\w+)?|fdisk|parted|dd\s+[^\n]*\bof=\/dev\/)/,
    warning: 'Writes directly to block devices / filesystems',
  },
  {
    pattern: /\b(?:kubectl\s+delete|terraform\s+destroy|pulumi\s+destroy)\b/,
    warning: 'Destroys cloud or cluster infrastructure resources',
  },
  {
    pattern: /\bchmod\s+-R\s+777\b/,
    warning: 'Recursively grants world-writable permissions (chmod -R 777)',
  },
]

export function getDestructiveCommandWarning(command: string): string | null {
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) {
      return rule.warning
    }
  }
  return null
}
