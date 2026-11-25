export function intersperse<T>(
  items: T[],
  separator: (index: number) => T,
): T[] {
  return items.flatMap((item, index) =>
    index ? [separator(index), item] : [item],
  )
}

export function count<T>(
  items: readonly T[],
  predicate: (item: T) => unknown,
): number {
  let matched = 0
  for (const item of items) {
    if (predicate(item)) matched++
  }
  return matched
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)]
}
