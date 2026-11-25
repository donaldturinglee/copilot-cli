const NO_VALUE = Symbol('NO_VALUE')

export async function lastX<T>(items: AsyncGenerator<T>): Promise<T> {
  let lastValue: T | typeof NO_VALUE = NO_VALUE
  for await (const item of items) {
    lastValue = item
  }
  if (lastValue === NO_VALUE) {
    throw new Error('No items in generator')
  }
  return lastValue
}

export async function returnValue<T>(
  generator: AsyncGenerator<unknown, T>,
): Promise<T> {
  let step
  do {
    step = await generator.next()
  } while (!step.done)
  return step.value
}

type QueuedGenerator<T> = {
  done: boolean | void
  value: T | void
  generator: AsyncGenerator<T, void>
  promise: Promise<QueuedGenerator<T>>
}

// Run all generators concurrently up to a concurrency cap, yielding values as they come in
export async function* all<T>(
  generators: AsyncGenerator<T, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<T, void> {
  const next = (generator: AsyncGenerator<T, void>) => {
    const promise: Promise<QueuedGenerator<T>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise,
      }))
    return promise
  }
  const waiting = [...generators]
  const promises = new Set<Promise<QueuedGenerator<T>>>()

  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!
    promises.add(next(gen))
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise)

    if (!done) {
      promises.add(next(generator))
      if (value !== undefined) {
        yield value
      }
    } else if (waiting.length > 0) {
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}

export async function toArray<T>(
  generator: AsyncGenerator<T, void>,
): Promise<T[]> {
  const result: T[] = []
  for await (const item of generator) {
    result.push(item)
  }
  return result
}

export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value
  }
}
