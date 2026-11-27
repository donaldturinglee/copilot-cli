import type { LayoutNode } from './node.js'
import { YogaLayoutNode } from './yoga.js'

export function createLayoutNode(): LayoutNode {
  return new YogaLayoutNode()
}
