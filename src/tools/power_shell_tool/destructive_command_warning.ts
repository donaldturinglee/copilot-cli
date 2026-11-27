/**
 * Destructive PowerShell command warnings for permission prompts.
 */

const PS_DESTRUCTIVE_RULES: ReadonlyArray<{ pattern: RegExp; warning: string }> = [
  {
    pattern: /\b(?:remove-item|rm|del|ri|rd|erase)\b[^\n]*(?:-recurse|-force|-r\b|-rf\b)/i,
    warning: 'Recursively or forcefully deletes files (Remove-Item -Recurse/-Force)',
  },
  {
    pattern: /\b(?:stop-computer|restart-computer|format-volume|clear-disk)\b/i,
    warning: 'Modifies system power state or wipes storage volumes',
  },
  {
    pattern: /\bgit\s+push\b[^\n]*(?:--force\b|-f\b)/i,
    warning: 'Force-pushes git history and may overwrite remote commits',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    warning: 'Permanently discards local working-tree changes (git reset --hard)',
  },
]

export function getPowerShellDestructiveWarning(command: string): string | null {
  for (const rule of PS_DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) {
      return rule.warning
    }
  }
  return null
}
