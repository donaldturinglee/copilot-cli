import { useEffect, useState } from 'react'
import { getInMemoryErrors } from '../utilities/log.js'

export function useLogMessages(refreshKey = 0): readonly string[] {
  const [errors, setErrors] = useState<string[]>([])

  useEffect(() => {
    const raw = getInMemoryErrors()
    setErrors(
      raw.map(item =>
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && 'error' in item
            ? String((item as { error: unknown }).error)
            : String(item),
      ),
    )
  }, [refreshKey])

  return errors
}
