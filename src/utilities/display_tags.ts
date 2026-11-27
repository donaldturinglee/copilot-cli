const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const BASH_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/
const BASH_STDERR_RE = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/

export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

export function extractTagContent(
  text: string,
  tagName: string,
): string | null {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`)
  const m = re.exec(text)
  return m ? m[1]! : null
}

export type ParsedDisplayTags = {
  commandName?: string
  localStdout?: string
  bashStdout?: string
  bashStderr?: string
  plainText: string
}

export function parseDisplayTags(raw: string): ParsedDisplayTags {
  const cleaned = stripSystemReminders(raw)
  const commandName = COMMAND_NAME_RE.exec(cleaned)?.[1]?.trim()
  const localStdout = LOCAL_STDOUT_RE.exec(cleaned)?.[1]
  const bashStdout = BASH_STDOUT_RE.exec(cleaned)?.[1]
  const bashStderr = BASH_STDERR_RE.exec(cleaned)?.[1]
  const plainText = cleaned
    .replace(COMMAND_NAME_RE, '')
    .replace(LOCAL_STDOUT_RE, '')
    .replace(BASH_STDOUT_RE, '')
    .replace(BASH_STDERR_RE, '')
    .trim()
  return { commandName, localStdout, bashStdout, bashStderr, plainText }
}
