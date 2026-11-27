import type { EventHandler, EventHandlerMap } from './events/event_handlers.js'
import type { FocusManager } from './focus.js'
import { createLayoutNode } from './layout/engine.js'
import type { Rectangle } from './layout/geometry.js'
import type { LayoutNode } from './layout/node.js'
import type { Styles } from './styles.js'

export type ElementNames =
  | 'ink-root'
  | 'ink-box'
  | 'ink-text'
  | 'ink-virtual-text'
  | 'ink-link'
  | 'ink-raw-ansi'
  | 'ink-scroll-box'

export type DOMNodeAttribute = boolean | string | number | string[] | undefined

export type OutputTransformer = (text: string, index: number) => string

export type ScrollBoxState = {
  scrollTop: number
  prevScrollTop: number
  stickyBottom: boolean
  contentHeight: number
  viewportHeight: number
}

export type DOMElement = {
  nodeName: ElementNames
  attributes: Record<string, DOMNodeAttribute>
  childNodes: DOMNode[]
  style: Styles
  layoutNode: LayoutNode | undefined
  parentNode: DOMElement | undefined
  internal_transform?: OutputTransformer
  internal_static?: boolean
  internal_rawAnsiLines?: string[]
  internal_rawAnsiWidth?: number
  internal_scrollState?: ScrollBoxState
  internal_lastRect?: Rectangle
  dirty: boolean
  focusManager?: FocusManager
  eventHandlers?: EventHandlerMap
  eventListeners?: Map<
    string,
    Set<{ handler: EventHandler; capture: boolean }>
  >
  onComputeLayout?: () => void
  onRender?: () => void
  onImmediateRender?: () => void
}

export type TextNode = {
  nodeName: '#text'
  nodeValue: string
  parentNode: DOMElement | undefined
  layoutNode: undefined
}

export type DOMNode = DOMElement | TextNode

export function createNode(nodeName: ElementNames): DOMElement {
  const isVirtual =
    nodeName === 'ink-virtual-text' || nodeName === 'ink-link'
  const node: DOMElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    layoutNode: isVirtual ? undefined : createLayoutNode(),
    dirty: true,
  }

  if (nodeName === 'ink-scroll-box') {
    node.internal_scrollState = {
      scrollTop: 0,
      prevScrollTop: 0,
      stickyBottom: false,
      contentHeight: 0,
      viewportHeight: 0,
    }
  }

  return node
}

export function createTextNode(text: string): TextNode {
  return {
    nodeName: '#text',
    nodeValue: text,
    parentNode: undefined,
    layoutNode: undefined,
  }
}

export function markNodeDirty(node: DOMElement | undefined): void {
  let cur: DOMElement | undefined = node
  while (cur) {
    cur.dirty = true
    cur.layoutNode?.markDirty()
    cur = cur.parentNode
  }
}

export function appendChildNode(parent: DOMElement, child: DOMNode): void {
  if (child.parentNode) {
    removeChildNode(child.parentNode, child)
  }
  child.parentNode = parent
  parent.childNodes.push(child)

  if (child.layoutNode && parent.layoutNode) {
    parent.layoutNode.insertChild(
      child.layoutNode,
      parent.layoutNode.getChildCount(),
    )
  }

  markNodeDirty(parent)
}

export function insertBeforeNode(
  parent: DOMElement,
  newChild: DOMNode,
  beforeChild: DOMNode,
): void {
  if (newChild.parentNode) {
    removeChildNode(newChild.parentNode, newChild)
  }
  newChild.parentNode = parent
  const index = parent.childNodes.indexOf(beforeChild)
  if (index >= 0) {
    parent.childNodes.splice(index, 0, newChild)
    if (newChild.layoutNode && parent.layoutNode) {
      let layoutIdx = 0
      for (let i = 0; i < index; i++) {
        if (parent.childNodes[i]?.layoutNode) layoutIdx++
      }
      parent.layoutNode.insertChild(newChild.layoutNode, layoutIdx)
    }
  } else {
    parent.childNodes.push(newChild)
    if (newChild.layoutNode && parent.layoutNode) {
      parent.layoutNode.insertChild(
        newChild.layoutNode,
        parent.layoutNode.getChildCount(),
      )
    }
  }

  markNodeDirty(parent)
}

export function removeChildNode(parent: DOMElement, child: DOMNode): void {
  if (child.layoutNode && parent.layoutNode) {
    parent.layoutNode.removeChild(child.layoutNode)
  }
  const index = parent.childNodes.indexOf(child)
  if (index >= 0) {
    parent.childNodes.splice(index, 1)
  }
  child.parentNode = undefined
  markNodeDirty(parent)
}

export function setAttribute(
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void {
  node.attributes[key] = value
  markNodeDirty(node)
}

export function setStyle(node: DOMElement, style: Styles): void {
  node.style = style
  if (node.layoutNode) {
    node.layoutNode.applyStyles(style)
  }
  markNodeDirty(node)
}

export function setTextNodeValue(node: TextNode, text: string): void {
  if (node.nodeValue === text) return
  node.nodeValue = text
  markNodeDirty(node.parentNode)
}

export function addEventListener(
  node: DOMElement,
  type: string,
  handler: EventHandler,
  capture = false,
): () => void {
  if (!node.eventListeners) {
    node.eventListeners = new Map()
  }
  let set = node.eventListeners.get(type)
  if (!set) {
    set = new Set()
    node.eventListeners.set(type, set)
  }
  const entry = { handler, capture }
  set.add(entry)
  return () => {
    set?.delete(entry)
  }
}

export function removeEventListener(
  node: DOMElement,
  type: string,
  handler: EventHandler,
  capture = false,
): void {
  const set = node.eventListeners?.get(type)
  if (!set) return
  for (const entry of set) {
    if (entry.handler === handler && entry.capture === capture) {
      set.delete(entry)
    }
  }
}
