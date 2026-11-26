import { LRUCache } from 'lru-cache'
import { logError } from './log.js'
import { jsonStringify } from './slow_operations.js'

type CacheEntry<Value> = {
  value: Value
  timestamp: number
  refreshing: boolean
}

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
  }
}

type LruMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}

const DEFAULT_CACHE_LIFETIME_MS = 5 * 60 * 1000

/**
 * Creates a memoized function that returns cached values while refreshing in parallel.
 * Implements a stale-while-revalidate cache pattern.
 */
export function memoizeWithTtl<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
  cacheLifetimeMs: number = DEFAULT_CACHE_LIFETIME_MS,
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()

  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    if (!cached) {
      const value = fn(...args)
      cache.set(key, {
        value,
        timestamp: now,
        refreshing: false,
      })
      return value
    }

    if (now - cached.timestamp > cacheLifetimeMs && !cached.refreshing) {
      cached.refreshing = true

      Promise.resolve()
        .then(() => {
          const newValue = fn(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(error => {
          logError(error)
          if (cache.get(key) === cached) {
            cache.delete(key)
          }
        })

      return cached.value
    }

    return cache.get(key)!.value
  }

  memoized.cache = {
    clear: () => cache.clear(),
  }

  return memoized
}

/**
 * Creates a memoized async function that returns cached values while refreshing in parallel.
 * Deduplicates concurrent cold-miss callers via an in-flight promise map.
 */
export function memoizeWithTtlAsync<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = DEFAULT_CACHE_LIFETIME_MS,
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) return pending
      const promise = fn(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        if (inFlight.get(key) === promise) {
          cache.set(key, {
            value: result,
            timestamp: now,
            refreshing: false,
          })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key)
        }
      }
    }

    if (now - cached.timestamp > cacheLifetimeMs && !cached.refreshing) {
      cached.refreshing = true

      const staleEntry = cached
      fn(...args)
        .then(newValue => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(error => {
          logError(error)
          if (cache.get(key) === staleEntry) {
            cache.delete(key)
          }
        })

      return cached.value
    }

    return cache.get(key)!.value
  }

  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }

  return memoized as ((...args: Args) => Promise<Result>) & {
    cache: { clear: () => void }
  }
}

/**
 * Creates a memoized function with LRU (Least Recently Used) eviction policy.
 */
export function memoizeWithLru<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  fn: (...args: Args) => Result,
  cacheKeyFn: (...args: Args) => string,
  maxCacheSize = 100,
): LruMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({
    max: maxCacheSize,
  })

  const memoized = (...args: Args): Result => {
    const key = cacheKeyFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const result = fn(...args)
    cache.set(key, result)
    return result
  }

  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  }

  return memoized
}
