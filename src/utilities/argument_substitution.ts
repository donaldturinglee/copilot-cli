import { splitCommandArgs } from './slash_command_parsing.js'

/**
 * Substitute `$ARGUMENTS`, `$1..$N`, `$ARGUMENTS[i]`, and `${N:-default}`
 * placeholders inside prompt-type slash commands.
 */
export function substituteCommandArguments(
  template: string,
  rawArgs: string,
  argNames?: readonly string[],
): string {
  const parts = splitCommandArgs(rawArgs)
  let hasPlaceholder = false

  let output = template.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idxStr: string) => {
    hasPlaceholder = true
    const idx = Number(idxStr)
    return parts[idx] ?? ''
  })

  output = output.replace(/\$ARGUMENTS\b/g, () => {
    hasPlaceholder = true
    return rawArgs
  })

  output = output.replace(/\$\{(\d+)(?::-([^}]*))?\}/g, (_, idxStr: string, fallback?: string) => {
    hasPlaceholder = true
    const idx = Number(idxStr) - 1
    return parts[idx] ?? fallback ?? ''
  })

  output = output.replace(/\$(\d+)\b/g, (_, idxStr: string) => {
    hasPlaceholder = true
    const idx = Number(idxStr) - 1
    return parts[idx] ?? ''
  })

  if (argNames && argNames.length > 0) {
    for (let i = 0; i < argNames.length; i++) {
      const name = argNames[i]!
      const re = new RegExp(`\\$\\{${name}\\}|\\$${name}\\b`, 'g')
      if (re.test(output)) {
        hasPlaceholder = true
        output = output.replace(re, parts[i] ?? '')
      }
    }
  }

  // Append arguments automatically if the prompt template did not reference them
  if (!hasPlaceholder && rawArgs.trim().length > 0) {
    output = `${output.trimEnd()}\n\nARGUMENTS: ${rawArgs.trim()}`
  }

  return output
}

/**
 * Substitutes `$ARGUMENTS`, `$ARGUMENTS[i]` (0-based), `$1..$N` (1-based) / `$0`,
 * and named `$argName` / `${argName}` variables in skill markdown templates.
 */
export function substituteArguments(
  content: string,
  args: string,
  appendIfNoPlaceholder = true,
  argumentNames?: readonly string[],
): string {
  if (!appendIfNoPlaceholder) {
    const parts = splitCommandArgs(args)
    let out = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idxStr: string) => {
      return parts[Number(idxStr)] ?? ''
    })
    out = out.replace(/\$ARGUMENTS\b/g, () => args)
    out = out.replace(/\$(\d+)\b/g, (_, idxStr: string) => {
      const idx = Number(idxStr)
      return idx === 0 ? (parts[0] ?? '') : (parts[idx - 1] ?? '')
    })
    if (argumentNames?.length) {
      for (let i = 0; i < argumentNames.length; i++) {
        const name = argumentNames[i]!
        const re = new RegExp(`\\$\\{${name}\\}|\\$${name}(?![\\[\\w])`, 'g')
        out = out.replace(re, parts[i] ?? '')
      }
    }
    return out
  }
  return substituteCommandArguments(content, args, argumentNames)
}
