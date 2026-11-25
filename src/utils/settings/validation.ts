import type { ZodError } from 'zod/v4'
import { safeParseJson } from '../json.js'
import { validatePermissionRule } from './permission_validation.js'
import { generateSettingsJsonSchema } from './schema_output.js'
import { type SettingsJson, SettingsSchema } from './types.js'
import { getValidationTip } from './validation_tips.js'

export type FieldPath = string

export type ValidationError = {
  file?: string
  path: FieldPath
  message: string
  expected?: string
  invalidValue?: unknown
  suggestion?: string
  docLink?: string
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

export function formatZodError(
  error: ZodError,
  filePath: string,
): ValidationError[] {
  return error.issues.map(issue => {
    const fieldPath = issue.path.map(String).join('.')
    const issueRecord = issue as unknown as Record<string, unknown>
    const expected =
      typeof issueRecord.expected === 'string'
        ? issueRecord.expected
        : undefined
    const received =
      typeof issueRecord.received === 'string'
        ? issueRecord.received
        : undefined
    const enumValues = Array.isArray(issueRecord.values)
      ? issueRecord.values.map(String)
      : undefined
    const keys = Array.isArray(issueRecord.keys)
      ? issueRecord.keys.map(String)
      : undefined

    let message = issue.message
    if (fieldPath === '' && expected === 'object' && received === 'null') {
      message = 'Invalid or malformed JSON'
    } else if (issue.code === 'unrecognized_keys' && keys && keys.length > 0) {
      message = `Unrecognized key(s) in object: ${keys.join(', ')}`
    }

    const tip = getValidationTip({
      path: fieldPath,
      code: issue.code,
      expected,
      received,
      enumValues,
      keys,
    })

    return {
      file: filePath,
      path: fieldPath,
      message,
      ...(expected ? { expected } : {}),
      ...(tip?.suggestion ? { suggestion: tip.suggestion } : {}),
      ...(tip?.docLink ? { docLink: tip.docLink } : {}),
    }
  })
}

export function validateSettingsFileContent(
  content: string,
): { isValid: true } | { isValid: false; error: string; fullSchema: string } {
  const jsonData = safeParseJson(content, false)
  if (jsonData === null || typeof jsonData !== 'object') {
    return {
      isValid: false,
      error: 'Invalid JSON syntax or non-object root value',
      fullSchema: generateSettingsJsonSchema(),
    }
  }

  const result = SettingsSchema().strict().safeParse(jsonData)
  if (result.success) {
    return { isValid: true }
  }

  const formatted = formatZodError(result.error, 'settings.json')
    .map(err => (err.path ? `${err.path}: ${err.message}` : err.message))
    .join('\n')

  return {
    isValid: false,
    error: formatted,
    fullSchema: generateSettingsJsonSchema(),
  }
}

/**
 * Strips invalid permission rules from a raw settings object in place so one
 * malformed rule never invalidates the entire settings file.
 */
export function filterInvalidPermissionRules(
  data: unknown,
  filePath: string,
): ValidationError[] {
  const errors: ValidationError[] = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return errors
  }

  const record = data as Record<string, unknown>
  const permissions = record.permissions
  if (
    !permissions ||
    typeof permissions !== 'object' ||
    Array.isArray(permissions)
  ) {
    return errors
  }

  const permRecord = permissions as Record<string, unknown>
  for (const key of ['allow', 'deny', 'ask'] as const) {
    const rules = permRecord[key]
    if (!Array.isArray(rules)) {
      continue
    }

    const validRules: string[] = []
    for (let index = 0; index < rules.length; index++) {
      const rule = rules[index]
      if (typeof rule !== 'string') {
        errors.push({
          file: filePath,
          path: `permissions.${key}.${index}`,
          message: `Expected string permission rule, received ${typeof rule}`,
          invalidValue: rule,
        })
        continue
      }

      const validation = validatePermissionRule(rule)
      if (!validation.valid) {
        errors.push({
          file: filePath,
          path: `permissions.${key}.${index}`,
          message: validation.error ?? `Invalid permission rule: "${rule}"`,
          invalidValue: rule,
          ...(validation.suggestion
            ? { suggestion: validation.suggestion }
            : {}),
        })
        continue
      }

      validRules.push(rule)
    }

    permRecord[key] = validRules
  }

  return errors
}
