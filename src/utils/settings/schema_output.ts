import { toJSONSchema } from 'zod/v4'
import { jsonStringify } from '../slow_operations.js'
import { SettingsSchema } from './types.js'

export function generateSettingsJsonSchema(): string {
  return jsonStringify(
    toJSONSchema(SettingsSchema(), { unrepresentable: 'any' }),
    null,
    2,
  )
}
