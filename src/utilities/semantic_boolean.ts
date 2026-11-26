import { z } from 'zod/v4'

/**
 * Boolean that also accepts the string literals "true"/"false".
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  )
}
