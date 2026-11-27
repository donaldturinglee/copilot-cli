/**
 * Quote normalization, occurrence counting, string replacement, and settings
 * file validation utilities for `FileEditTool` (`Edit`).
 */

import { basename } from 'path'
import { SettingsSchema } from '../../utilities/settings/types.js'

const LEFT_SINGLE_CURLY = '\u2018'
const RIGHT_SINGLE_CURLY = '\u2019'
const LEFT_DOUBLE_CURLY = '\u201C'
const RIGHT_DOUBLE_CURLY = '\u201D'

/**
 * Normalizes typographic/curly quotes to ASCII straight quotes for fuzzy
 * matching when the model submits ASCII quotes for a file containing curly
 * quotes.
 */
export function normalizeQuotes(text: string): string {
  return text
    .replaceAll(LEFT_SINGLE_CURLY, "'")
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"')
}

/**
 * Finds the exact substring in `fileContent` matching `searchString` either
 * verbatim or via curly-quote normalization.
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }

  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx === -1) {
    return null
  }
  return fileContent.slice(idx, idx + searchString.length)
}

/**
 * Applies curly-quote style from `actualOldString` to `newString` when the
 * model replaced curly quotes with straight quotes.
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) {
    return newString
  }
  let result = newString
  if (
    actualOldString.includes(LEFT_DOUBLE_CURLY) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY)
  ) {
    let open = true
    result = result.replace(/"/g, () => {
      const ch = open ? LEFT_DOUBLE_CURLY : RIGHT_DOUBLE_CURLY
      open = !open
      return ch
    })
  }
  if (
    actualOldString.includes(LEFT_SINGLE_CURLY) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY)
  ) {
    result = result.replace(/'/g, RIGHT_SINGLE_CURLY)
  }
  return result
}

/**
 * Counts non-overlapping occurrences of `needle` in `haystack`.
 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while (true) {
    const found = haystack.indexOf(needle, pos)
    if (found === -1) break
    count++
    pos = found + needle.length
  }
  return count
}

/**
 * Applies a single or global replacement without interpreting `$` replacement
 * patterns in `newString`.
 */
export function applyStringEdit(
  fileContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  if (oldString === '') {
    return newString
  }
  if (replaceAll) {
    return fileContent.split(oldString).join(newString)
  }
  const idx = fileContent.indexOf(oldString)
  if (idx === -1) {
    return fileContent
  }
  return (
    fileContent.slice(0, idx) +
    newString +
    fileContent.slice(idx + oldString.length)
  )
}

/**
 * Validates that edits targeting a `.copilot/settings*.json` or
 * `settings.json` file under `.copilot` produce valid JSON conforming to
 * `SettingsSchema`.
 */
export function validateInputForSettingsFileEdit(
  filePath: string,
  updatedContent: string,
): { valid: true } | { valid: false; message: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const base = basename(normalized)
  const isSettingsFile =
    (base === 'settings.json' || base === 'settings.local.json') &&
    normalized.includes('/.copilot/')

  if (!isSettingsFile) {
    return { valid: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(updatedContent)
  } catch (error) {
    return {
      valid: false,
      message: `Edit would produce invalid JSON in settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const check = SettingsSchema().safeParse(parsed)
  if (!check.success) {
    const firstIssue = check.error.issues[0]
    return {
      valid: false,
      message: `Edit violates settings schema in ${filePath}: ${firstIssue ? `${firstIssue.path.join('.')}: ${firstIssue.message}` : check.error.message}`,
    }
  }

  return { valid: true }
}
