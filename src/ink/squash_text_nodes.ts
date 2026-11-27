import type { DOMElement } from './dom.js'
import { hyperlink as oscHyperlink } from './termio/osc.js'

/**
 * Flatten an `ink-text` (and nested `ink-virtual-text` / `ink-link` / `#text`)
 * subtree into a single ANSI-styled string, applying `internal_transform`
 * closures bottom-up.
 */
export function squashTextNodes(node: DOMElement): string {
  let text = ''

  for (let index = 0; index < node.childNodes.length; index++) {
    const child = node.childNodes[index]!
    let childText = ''

    if (child.nodeName === '#text') {
      childText = child.nodeValue
    } else if (
      child.nodeName === 'ink-text' ||
      child.nodeName === 'ink-virtual-text' ||
      child.nodeName === 'ink-link'
    ) {
      childText = squashTextNodes(child)
      if (child.nodeName === 'ink-link') {
        const href = child.attributes['href']
        if (typeof href === 'string' && href.length > 0 && childText.length > 0) {
          childText = oscHyperlink(href, childText)
        }
      }
      if (child.internal_transform) {
        childText = child.internal_transform(childText, index)
      }
    }

    text += childText
  }

  return text
}
