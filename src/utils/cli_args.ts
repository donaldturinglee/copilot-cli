/**
 * Linearly scans argv for `--flag=value` or `--flag value` prior to Commander
 * option parsing (used for eager `--settings` and `--setting-sources` loading).
 */
export function eagerParseCliFlag(
  flagName: string,
  argv: string[] = process.argv,
): string | undefined {
  const prefix = `${flagName}=`
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length)
    }
    if (arg === flagName && i + 1 < argv.length) {
      return argv[i + 1]
    }
  }
  return undefined
}

/**
 * Unwraps a leading `--` separator passed before positional command arguments.
 */
export function extractArgsAfterDoubleDash(
  commandOrValue: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (commandOrValue === '--' && args.length > 0) {
    return { command: args[0]!, args: args.slice(1) }
  }
  return { command: commandOrValue, args }
}
