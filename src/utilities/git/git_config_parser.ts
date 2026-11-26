/**
 * Pure `.git/config` INI parser matching Git's `config.c` section/subsection
 * casing, inline comment handling, and escape rules.
 */

function stripInlineCommentAndUnquote(raw: string): string {
  let result = ''
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      switch (ch) {
        case 'n':
          result += '\n'
          break
        case 't':
          result += '\t'
          break
        case 'b':
          result += '\b'
          break
        default:
          result += ch
          break
      }
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (!inQuotes && (ch === '#' || ch === ';')) {
      break
    }
    result += ch
  }

  return result.trim()
}

function parseSectionHeader(
  line: string,
): { section: string; subsection?: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[')) {
    return null
  }
  const closeIdx = trimmed.lastIndexOf(']')
  if (closeIdx <= 1) {
    return null
  }
  const inside = trimmed.slice(1, closeIdx).trim()
  const quoteStart = inside.indexOf('"')
  if (quoteStart === -1) {
    const spaceIdx = inside.search(/\s/)
    if (spaceIdx === -1) {
      return { section: inside.toLowerCase() }
    }
    return {
      section: inside.slice(0, spaceIdx).toLowerCase(),
      subsection: inside.slice(spaceIdx).trim(),
    }
  }

  const section = inside.slice(0, quoteStart).trim().toLowerCase()
  let subsection = ''
  let escaped = false
  for (let i = quoteStart + 1; i < inside.length; i++) {
    const ch = inside[i]!
    if (escaped) {
      subsection += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      break
    }
    subsection += ch
  }
  return { section, subsection }
}

/**
 * Parses a git config string into a map keyed by `section.key` or
 * `section.subsection.key` (last entry wins, matching Git semantics).
 */
export function parseConfigString(content: string): Map<string, string> {
  const map = new Map<string, string>()
  let currentSection = ''
  let currentSubsection: string | undefined

  const rawLines = content.split(/\r?\n/)
  const lines: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]!
    while (line.endsWith('\\') && i + 1 < rawLines.length) {
      line = line.slice(0, -1) + rawLines[++i]!
    }
    lines.push(line)
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }
    if (trimmed.startsWith('[')) {
      const header = parseSectionHeader(trimmed)
      if (header) {
        currentSection = header.section
        currentSubsection = header.subsection
      }
      continue
    }
    if (!currentSection) {
      continue
    }

    const eqIdx = trimmed.indexOf('=')
    let key: string
    let value: string
    if (eqIdx === -1) {
      key = trimmed.toLowerCase()
      value = 'true'
    } else {
      key = trimmed.slice(0, eqIdx).trim().toLowerCase()
      value = stripInlineCommentAndUnquote(trimmed.slice(eqIdx + 1))
    }

    if (!key) continue
    const fullKey =
      currentSubsection !== undefined
        ? `${currentSection}.${currentSubsection}.${key}`
        : `${currentSection}.${key}`
    map.set(fullKey, value)
  }

  return map
}

/**
 * Looks up a single config entry (`section`, optional `subsection`, `key`) from
 * a raw `.git/config` string.
 */
export function parseGitConfigValue(
  content: string,
  section: string,
  key: string,
  subsection?: string,
): string | undefined {
  const parsed = parseConfigString(content)
  const fullKey =
    subsection !== undefined
      ? `${section.toLowerCase()}.${subsection}.${key.toLowerCase()}`
      : `${section.toLowerCase()}.${key.toLowerCase()}`
  return parsed.get(fullKey)
}
