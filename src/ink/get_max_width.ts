import type { LayoutNode } from './layout/node.js'

export function getMaxWidth(layoutNode: LayoutNode): number {
  return (
    layoutNode.getComputedWidth() -
    layoutNode.getComputedPaddingLeft() -
    layoutNode.getComputedPaddingRight() -
    layoutNode.getComputedBorderLeft() -
    layoutNode.getComputedBorderRight()
  )
}
