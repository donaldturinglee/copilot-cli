import type { DOMElement } from './dom.js'
import { containsPoint } from './layout/geometry.js'

/**
 * Find the deepest rendered `DOMElement` whose laid-out screen rectangle
 * contains `(col, row)` in 0-based screen coordinates.
 */
export function hitTest(
  root: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  return hitTestNode(root, col, row, 0, 0)
}

function hitTestNode(
  node: DOMElement,
  col: number,
  row: number,
  offsetX: number,
  offsetY: number,
): DOMElement | null {
  if (node.style.display === 'none') return null

  const rect = node.internal_lastRect ?? (
    node.layoutNode
      ? {
          x: offsetX + node.layoutNode.getComputedLeft(),
          y: offsetY + node.layoutNode.getComputedTop(),
          width: node.layoutNode.getComputedWidth(),
          height: node.layoutNode.getComputedHeight(),
        }
      : undefined
  )

  if (!rect || !containsPoint(rect, col, row)) {
    return null
  }

  const scrollY = node.internal_scrollState?.scrollTop ?? 0
  // Reverse iteration respects paint order (later siblings sit on top)
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    if (child.nodeName === '#text') continue
    const hit = hitTestNode(child, col, row, rect.x, rect.y - scrollY)
    if (hit) return hit
  }

  return node
}
