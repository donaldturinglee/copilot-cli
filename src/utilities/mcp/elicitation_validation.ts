/**
 * Schema inspection and field-level validation for MCP Elicitation forms
 * (`string`, `number`, `integer`, `boolean`, single-select `enum`/`oneOf`, and
 * multi-select `array` enums).
 */

export interface ElicitationPropertySchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  title?: string
  description?: string
  default?: unknown
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: 'email' | 'uri' | 'date' | 'date-time' | string
  minimum?: number
  maximum?: number
  enum?: string[]
  enumNames?: string[]
  oneOf?: Array<{ const: string; title?: string }>
  items?: {
    type?: string
    enum?: string[]
    anyOf?: Array<{ const: string; title?: string }>
  }
  minItems?: number
  maxItems?: number
}

export interface ElicitationObjectSchema {
  type?: 'object'
  properties?: Record<string, ElicitationPropertySchema>
  required?: string[]
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Returns true if `schema` represents a single-select enum field.
 */
export function isEnumSchema(schema: ElicitationPropertySchema): boolean {
  return (
    (Array.isArray(schema.enum) && schema.enum.length > 0) ||
    (Array.isArray(schema.oneOf) && schema.oneOf.length > 0)
  )
}

/**
 * Extracts raw selectable values from a single-select enum schema.
 */
export function getEnumValues(schema: ElicitationPropertySchema): string[] {
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map(item => item.const)
  }
  return schema.enum ? [...schema.enum] : []
}

/**
 * Resolves the human-readable display label for an enum value.
 */
export function getEnumLabel(
  schema: ElicitationPropertySchema,
  value: string,
): string {
  if (Array.isArray(schema.oneOf)) {
    const found = schema.oneOf.find(item => item.const === value)
    if (found?.title) {
      return found.title
    }
  }
  if (Array.isArray(schema.enum) && Array.isArray(schema.enumNames)) {
    const idx = schema.enum.indexOf(value)
    if (idx >= 0 && schema.enumNames[idx]) {
      return schema.enumNames[idx]!
    }
  }
  return value
}

/**
 * Returns true if `schema` represents a multi-select enum array field.
 */
export function isMultiSelectEnumSchema(
  schema: ElicitationPropertySchema,
): boolean {
  return (
    schema.type === 'array' &&
    Boolean(
      (schema.items?.enum && schema.items.enum.length > 0) ||
        (schema.items?.anyOf && schema.items.anyOf.length > 0),
    )
  )
}

/**
 * Extracts selectable `{ value, label }` items from a multi-select enum schema.
 */
export function getMultiSelectValues(
  schema: ElicitationPropertySchema,
): Array<{ value: string; label: string }> {
  if (schema.items?.anyOf) {
    return schema.items.anyOf.map(entry => ({
      value: entry.const,
      label: entry.title ?? entry.const,
    }))
  }
  if (schema.items?.enum) {
    return schema.items.enum.map(val => ({ value: val, label: val }))
  }
  return []
}

/**
 * Coerces numeric string input into a `number` or returns `null` if invalid.
 */
export function coerceNumberValue(
  raw: string,
  integerOnly = false,
): number | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (integerOnly && !Number.isInteger(parsed)) {
    return null
  }
  return parsed
}

/**
 * Validates a single field value against `ElicitationPropertySchema`.
 * Returns `null` when valid, or an error message string when invalid.
 */
export function validateFieldBySchema(
  value: unknown,
  schema: ElicitationPropertySchema,
): string | null {
  if (isMultiSelectEnumSchema(schema)) {
    if (!Array.isArray(value)) {
      return 'Expected an array of selected values'
    }
    const allowed = new Set(getMultiSelectValues(schema).map(item => item.value))
    for (const item of value) {
      if (typeof item !== 'string' || !allowed.has(item)) {
        return `Invalid selection "${String(item)}"`
      }
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `Select at least ${schema.minItems} item(s)`
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `Select at most ${schema.maxItems} item(s)`
    }
    return null
  }

  if (isEnumSchema(schema)) {
    const allowed = getEnumValues(schema)
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return `Must be one of: ${allowed.join(', ')}`
    }
    return null
  }

  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'Expected true or false'

    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return schema.type === 'integer'
          ? 'Expected a valid integer'
          : 'Expected a valid number'
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return 'Expected an integer without decimals'
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `Must be >= ${schema.minimum}`
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `Must be <= ${schema.maximum}`
      }
      return null
    }

    case 'string':
    default: {
      if (typeof value !== 'string') {
        return 'Expected a text value'
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `Must be at least ${schema.minLength} character(s)`
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `Must be at most ${schema.maxLength} character(s)`
      }
      if (schema.pattern) {
        try {
          const regex = new RegExp(schema.pattern)
          if (!regex.test(value)) {
            return `Must match pattern ${schema.pattern}`
          }
        } catch {
          // Ignore malformed server regex
        }
      }
      if (schema.format === 'email' && !EMAIL_REGEX.test(value)) {
        return 'Must be a valid email address'
      }
      if (schema.format === 'uri') {
        try {
          new URL(value)
        } catch {
          return 'Must be a valid URI'
        }
      }
      if (schema.format === 'date' && !ISO_DATE_REGEX.test(value)) {
        return 'Must be an ISO date (YYYY-MM-DD)'
      }
      if (schema.format === 'date-time' && !ISO_DATETIME_REGEX.test(value)) {
        return 'Must be an ISO 8601 date-time (e.g. 2026-05-01T14:30:00Z)'
      }
      return null
    }
  }
}

/**
 * Validates an entire elicitation submission record against `requestedSchema`.
 */
export function validateElicitationInput(
  values: Record<string, unknown>,
  requestedSchema: ElicitationObjectSchema,
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const properties = requestedSchema.properties ?? {}
  const required = new Set(requestedSchema.required ?? [])

  for (const reqField of required) {
    const val = values[reqField]
    if (val === undefined || val === null || val === '') {
      errors[reqField] = 'This field is required'
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    const val = values[key]
    if (val === undefined || val === null || val === '') {
      continue
    }
    const fieldError = validateFieldBySchema(val, propSchema)
    if (fieldError) {
      errors[key] = fieldError
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  }
}
