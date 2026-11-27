export type ParsedSlashCommand = {
  commandName: string
  args: string
  raw: string
}

export function isSlashCommandInput(input: string): boolean {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return false
  // Ignore file paths like `/usr/bin/foo` containing a slash inside the token
  const firstToken = trimmed.slice(1).split(/\s+/)[0] ?? ''
  if (!firstToken) return false
  if (firstToken.includes('/')) return false
  return true
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!isSlashCommandInput(input)) return null
  const trimmed = input.trim()
  const spaceIdx = trimmed.search(/\s/)
  if (spaceIdx === -1) {
    return {
      commandName: trimmed.slice(1),
      args: '',
      raw: trimmed,
    }
  }
  return {
    commandName: trimmed.slice(1, spaceIdx),
    args: trimmed.slice(spaceIdx + 1).trim(),
    raw: trimmed,
  }
}

export function splitCommandArgs(args: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }

  if (current.length > 0) tokens.push(current)
  return tokens
}
