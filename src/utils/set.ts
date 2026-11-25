export function difference<T>(first: Set<T>, second: Set<T>): Set<T> {
  const result = new Set<T>()
  for (const item of first) {
    if (!second.has(item)) {
      result.add(item)
    }
  }
  return result
}

export function intersects<T>(first: Set<T>, second: Set<T>): boolean {
  if (first.size === 0 || second.size === 0) {
    return false
  }
  for (const item of first) {
    if (second.has(item)) {
      return true
    }
  }
  return false
}

export function every<T>(
  first: ReadonlySet<T>,
  second: ReadonlySet<T>,
): boolean {
  for (const item of first) {
    if (!second.has(item)) {
      return false
    }
  }
  return true
}

export function union<T>(first: Set<T>, second: Set<T>): Set<T> {
  const result = new Set<T>()
  for (const item of first) {
    result.add(item)
  }
  for (const item of second) {
    result.add(item)
  }
  return result
}
