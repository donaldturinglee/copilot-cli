/**
 * Official marketplace constants, homograph / regex anti-spoofing checks, and
 * authentic repository source verification.
 */

export const OFFICIAL_MARKETPLACE_NAME = 'claude-plugins-official'
export const OFFICIAL_GITHUB_ORG = 'anthropics'
export const OFFICIAL_MARKETPLACE_REPO = 'anthropics/claude-plugins-official'

export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'claude-code-plugins',
  'copilot-plugins-official',
])

const IMPERSONATION_RE =
  /(?:official.*(?:anthropic|claude)|(?:anthropic|claude).*official|^(?:anthropic|claude)-(?:marketplace|plugins|official))/i

const NON_ASCII_RE = /[^\x20-\x7E]/

const CONFUSABLE_HOMOGLYPHS: Readonly<Record<string, string>> = {
  '\u0430': 'a', // Cyrillic small a
  '\u0441': 'c', // Cyrillic small es
  '\u0435': 'e', // Cyrillic small ie
  '\u0456': 'i', // Cyrillic small byelorussian-ukrainian i
  '\u043e': 'o', // Cyrillic small o
  '\u0440': 'p', // Cyrillic small er
  '\u0445': 'x', // Cyrillic small ha
  '\u0443': 'y', // Cyrillic small u
  '\u0455': 's', // Cyrillic small dze
  '\u0501': 'd', // Cyrillic small komi de
  '\u04cf': 'l', // Cyrillic small palochka
  '\u03b1': 'a', // Greek alpha
  '\u03bf': 'o', // Greek omicron
}

function foldHomoglyphs(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map(ch => CONFUSABLE_HOMOGLYPHS[ch.toLowerCase()] ?? ch)
    .join('')
}

/**
 * Returns true if `name` attempts to impersonate an official Anthropic/Claude
 * marketplace via reserved patterns or non-ASCII homoglyphs.
 */
export function isBlockedOfficialName(name: string): boolean {
  const normalized = name.trim()
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalized.toLowerCase())) {
    return false
  }
  const folded = foldHomoglyphs(normalized)
  if (NON_ASCII_RE.test(normalized) && /(?:claude|anthropic)/i.test(folded)) {
    return true
  }
  return IMPERSONATION_RE.test(folded)
}

/**
 * Verifies that a marketplace claiming one of `ALLOWED_OFFICIAL_MARKETPLACE_NAMES`
 * actually originates from the official `anthropics/*` GitHub organization.
 */
export function validateOfficialNameSource(
  name: string,
  source: { source: string; repo?: string; url?: string },
): { valid: boolean; reason?: string } {
  const lower = name.trim().toLowerCase()
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(lower)) {
    if (isBlockedOfficialName(name)) {
      return {
        valid: false,
        reason: `Marketplace name "${name}" is reserved to prevent spoofing official marketplaces.`,
      }
    }
    return { valid: true }
  }

  if (
    source.source === 'github' &&
    typeof source.repo === 'string' &&
    source.repo.toLowerCase().startsWith(`${OFFICIAL_GITHUB_ORG}/`)
  ) {
    return { valid: true }
  }

  if (
    source.source === 'git' &&
    typeof source.url === 'string' &&
    /github\.com[:/]anthropics\//i.test(source.url)
  ) {
    return { valid: true }
  }

  return {
    valid: false,
    reason: `Reserved official marketplace name "${name}" can only be used with official ${OFFICIAL_GITHUB_ORG}/* repositories.`,
  }
}
