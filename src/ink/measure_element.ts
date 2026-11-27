import type { DOMElement } from './dom.js'

export type ElementDimensions = {
  width: number
  height: number
}

export function measureElement(node: DOMElement): ElementDimensions {
  return {
    width: node.layoutNode?.getComputedWidth() ?? 0,
    height: node.layoutNode?.getComputedHeight() ?? 0,
  }
}
