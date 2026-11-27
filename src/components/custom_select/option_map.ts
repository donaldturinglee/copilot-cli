export type SelectOptionItem<T extends string = string> = {
  label: string
  value: T
  description?: string
  disabled?: boolean
}

export type OptionMapEntry<T extends string = string> = SelectOptionItem<T> & {
  index: number
  previous?: T
  next?: T
}

export class OptionMap<T extends string = string> {
  private readonly entries = new Map<T, OptionMapEntry<T>>()
  readonly first: OptionMapEntry<T> | undefined

  constructor(options: readonly SelectOptionItem<T>[]) {
    let prev: OptionMapEntry<T> | undefined
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]!
      const entry: OptionMapEntry<T> = {
        ...opt,
        index: i,
        previous: prev?.value,
      }
      if (prev) {
        prev.next = entry.value
      } else {
        this.first = entry
      }
      this.entries.set(opt.value, entry)
      prev = entry
    }
  }

  get(value: T): OptionMapEntry<T> | undefined {
    return this.entries.get(value)
  }

  get size(): number {
    return this.entries.size
  }

  values(): OptionMapEntry<T>[] {
    return [...this.entries.values()]
  }
}
