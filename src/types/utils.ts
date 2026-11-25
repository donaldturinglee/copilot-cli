type ImmutablePrimitive =
  | undefined
  | null
  | boolean
  | string
  | number
  | bigint
  | symbol
  | ((...args: never[]) => unknown)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  | Function

type DeepImmutableArray<T> = ReadonlyArray<DeepImmutable<T>>
type DeepImmutableMap<K, V> = ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
type DeepImmutableSet<T> = ReadonlySet<DeepImmutable<T>>
type DeepImmutableObject<T> = { readonly [K in keyof T]: DeepImmutable<T[K]> }

export type DeepImmutable<T> = unknown extends T
  ? T
  : T extends ImmutablePrimitive
    ? T
    : T extends ReadonlyMap<infer K, infer V>
      ? DeepImmutableMap<K, V>
      : T extends ReadonlySet<infer V>
        ? DeepImmutableSet<V>
        : T extends ReadonlyArray<infer U>
          ? number extends T['length']
            ? DeepImmutableArray<U>
            : DeepImmutableObject<T>
          : DeepImmutableObject<T>

export type Permutations<T, U = T> = [T] extends [never]
  ? []
  : U extends U
    ? [U, ...Permutations<Exclude<T, U>>]
    : never
