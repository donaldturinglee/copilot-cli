import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'

export type CachedSubtreeRect = {
  rect: Rectangle
  version: number
}

/**
 * WeakMap cache tracking previously rendered node screen coordinates for
 * fast double-buffer blitting of unchanged subtrees.
 */
export class NodeCache {
  private readonly cache = new WeakMap<DOMElement, CachedSubtreeRect>()
  private generation = 0

  nextFrame(): void {
    this.generation++
  }

  get(node: DOMElement): CachedSubtreeRect | undefined {
    return this.cache.get(node)
  }

  set(node: DOMElement, rect: Rectangle): void {
    this.cache.set(node, { rect: { ...rect }, version: this.generation })
  }

  invalidate(node: DOMElement): void {
    this.cache.delete(node)
  }
}
