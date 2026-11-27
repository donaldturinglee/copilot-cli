import React, { createContext } from 'react'
import Reconciler from 'react-reconciler'
import {
  ConcurrentRoot,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import {
  appendChildNode,
  createNode,
  createTextNode,
  type DOMElement,
  type DOMNode,
  type ElementNames,
  insertBeforeNode,
  markNodeDirty,
  type OutputTransformer,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  type TextNode,
} from './dom.js'
import type { EventHandlerMap } from './events/event_handlers.js'
import { measureText } from './measure_text.js'
import { squashTextNodes } from './squash_text_nodes.js'
import type { Styles } from './styles.js'
import { wrapText } from './wrap_text.js'

type HostProps = {
  style?: Styles
  children?: React.ReactNode
  internal_transform?: OutputTransformer
  internal_static?: boolean
  rawAnsiLines?: string[]
  rawAnsiWidth?: number
  scrollTop?: number
  stickyBottom?: boolean
  href?: string
  tabIndex?: number
  autoFocus?: boolean
  'aria-label'?: string
  'aria-role'?: string
} & EventHandlerMap

type HostContext = {
  isInsideText: boolean
}

const EVENT_HANDLER_KEYS: readonly (keyof EventHandlerMap)[] = [
  'onClick',
  'onClickCapture',
  'onMouseDown',
  'onMouseDownCapture',
  'onMouseUp',
  'onMouseUpCapture',
  'onWheel',
  'onWheelCapture',
  'onKeyDown',
  'onKeyDownCapture',
  'onFocus',
  'onBlur',
  'onPaste',
  'onPasteCapture',
]

function applyNodeProps(node: DOMElement, props: HostProps): void {
  if (props.style) {
    setStyle(node, props.style)
  }
  if (props.internal_transform !== undefined) {
    node.internal_transform = props.internal_transform
  }
  if (props.internal_static !== undefined) {
    node.internal_static = props.internal_static
  }
  if (props.rawAnsiLines !== undefined) {
    node.internal_rawAnsiLines = props.rawAnsiLines
  }
  if (props.rawAnsiWidth !== undefined) {
    node.internal_rawAnsiWidth = props.rawAnsiWidth
  }
  if (node.internal_scrollState) {
    if (props.stickyBottom !== undefined) {
      node.internal_scrollState.stickyBottom = props.stickyBottom
    }
    if (props.scrollTop !== undefined) {
      node.internal_scrollState.scrollTop = props.scrollTop
    }
  }
  if (props.href !== undefined) {
    setAttribute(node, 'href', props.href)
  }
  if (props.tabIndex !== undefined) {
    setAttribute(node, 'tabIndex', props.tabIndex)
  } else {
    delete node.attributes['tabIndex']
  }
  if (props['aria-label'] !== undefined) {
    setAttribute(node, 'aria-label', props['aria-label'])
  }
  if (props['aria-role'] !== undefined) {
    setAttribute(node, 'aria-role', props['aria-role'])
  }

  let hasHandlers = false
  const handlers: EventHandlerMap = {}
  for (const key of EVENT_HANDLER_KEYS) {
    const fn = props[key]
    if (typeof fn === 'function') {
      ;(handlers as Record<string, unknown>)[key] = fn
      hasHandlers = true
    }
  }
  node.eventHandlers = hasHandlers ? handlers : undefined

  if (node.nodeName === 'ink-text' && node.layoutNode) {
    node.layoutNode.setMeasureFunc((width, widthMode) => {
      const text = squashTextNodes(node)
      if (text.length === 0) return { width: 0, height: 0 }
      const measured = measureText(text)
      if (widthMode === 'undefined' || isNaN(width) || measured.width <= width) {
        return measured
      }
      const wrapped = wrapText(text, width, node.style.textWrap ?? 'wrap')
      return measureText(wrapped)
    })
  } else if (node.nodeName === 'ink-raw-ansi' && node.layoutNode) {
    node.layoutNode.setMeasureFunc(() => ({
      width: node.internal_rawAnsiWidth ?? 0,
      height: node.internal_rawAnsiLines?.length ?? 0,
    }))
  }

  markNodeDirty(node)
}

const HostTransitionContext = createContext<null>(null)
let currentUpdatePriority: number = NoEventPriority

export function setReconcilerDiscretePriority(): void {
  currentUpdatePriority = DiscreteEventPriority
}

export function resetReconcilerUpdatePriority(): void {
  currentUpdatePriority = NoEventPriority
}

export function flushInkSync<T>(fn?: () => T): T | undefined {
  let result: T | undefined
  if (fn) {
    inkReconciler.flushSyncFromReconciler(() => {
      result = fn()
    })
  } else {
    inkReconciler.flushSyncWork()
  }
  inkReconciler.flushPassiveEffects()
  inkReconciler.flushSyncWork()
  return result
}

const hostConfig: Reconciler.HostConfig<
  ElementNames,
  HostProps,
  DOMElement,
  DOMElement,
  TextNode,
  never,
  DOMElement,
  DOMElement,
  DOMElement,
  DOMElement,
  HostContext,
  never,
  ReturnType<typeof setTimeout>,
  number,
  null,
  null,
  null,
  never,
  never,
  never
> = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  supportsMicrotasks: true,
  isPrimaryRenderer: true,
  rendererVersion: '0.1.0',
  rendererPackageName: 'copilot-cli-ink',
  extraDevToolsConfig: null,

  noTimeout: -1,
  NotPendingTransition: null,
  HostTransitionContext,

  bindToConsole: (_methodName, _args, _badgeName) => () => {},
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  scheduleMicrotask: queueMicrotask,

  setCurrentUpdatePriority(newPriority) {
    currentUpdatePriority = newPriority
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority
  },
  resolveUpdatePriority() {
    if (currentUpdatePriority !== NoEventPriority) {
      return currentUpdatePriority
    }
    return DiscreteEventPriority
  },

  resolveEventType: () => null,
  resolveEventTimeStamp: () => performance.now(),
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  requestPostPaintCallback: cb => {
    queueMicrotask(() => cb(performance.now()))
  },
  resetFormInstance: () => {},

  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,

  getRootHostContext: () => ({ isInsideText: false }),
  getChildHostContext: (parentHostContext, type) => {
    const isInsideText =
      parentHostContext.isInsideText ||
      type === 'ink-text' ||
      type === 'ink-virtual-text' ||
      type === 'ink-link'
    if (parentHostContext.isInsideText === isInsideText) {
      return parentHostContext
    }
    return { isInsideText }
  },
  getPublicInstance: instance => instance as DOMElement,

  prepareForCommit: () => null,
  resetAfterCommit: rootNode => {
    rootNode.onComputeLayout?.()
    rootNode.onRender?.()
  },
  preparePortalMount: () => {},

  shouldSetTextContent: () => false,

  createInstance(type, props, _rootContainer, hostContext) {
    if (hostContext.isInsideText && type === 'ink-box') {
      throw new Error('<Box> cannot be nested inside <Text>')
    }
    const resolvedType: ElementNames =
      hostContext.isInsideText && type === 'ink-text'
        ? 'ink-virtual-text'
        : type
    const node = createNode(resolvedType)
    applyNodeProps(node, props)
    return node
  },

  createTextInstance(text, _rootContainer, hostContext) {
    if (!hostContext.isInsideText && text.trim().length > 0) {
      throw new Error(`Text string "${text}" must be rendered inside <Text>`)
    }
    return createTextNode(text)
  },

  appendInitialChild(parent, child) {
    appendChildNode(parent, child)
  },

  finalizeInitialChildren(_instance, _type, props) {
    return Boolean(props.autoFocus)
  },

  commitMount(instance, _type, props) {
    if (props.autoFocus) {
      let cur: DOMElement | undefined = instance
      while (cur) {
        if (cur.focusManager) {
          cur.focusManager.handleAutoFocus(instance)
          break
        }
        cur = cur.parentNode
      }
    }
  },

  appendChild(parent, child) {
    appendChildNode(parent, child)
  },

  appendChildToContainer(container, child) {
    appendChildNode(container, child)
  },

  insertBefore(parent, child, beforeChild) {
    insertBeforeNode(parent, child, beforeChild as DOMNode)
  },

  insertInContainerBefore(container, child, beforeChild) {
    insertBeforeNode(container, child, beforeChild as DOMNode)
  },

  removeChild(parent, child) {
    const root = findRoot(parent)
    removeChildNode(parent, child as DOMNode)
    if (root?.focusManager && (child as DOMNode).nodeName !== '#text') {
      root.focusManager.handleNodeRemoved(child as DOMElement, root)
    }
    freeLayoutSubtree(child as DOMNode)
  },

  removeChildFromContainer(container, child) {
    removeChildNode(container, child as DOMNode)
    if (container.focusManager && (child as DOMNode).nodeName !== '#text') {
      container.focusManager.handleNodeRemoved(child as DOMElement, container)
    }
    freeLayoutSubtree(child as DOMNode)
  },

  commitUpdate(instance, _type, _prevProps, nextProps) {
    applyNodeProps(instance, nextProps)
  },

  commitTextUpdate(textInstance, _oldText, newText) {
    setTextNodeValue(textInstance, newText)
  },

  resetTextContent: () => {},

  hideInstance(instance) {
    setStyle(instance, { ...instance.style, display: 'none' })
  },

  hideTextInstance(textInstance) {
    setTextNodeValue(textInstance, '')
  },

  unhideInstance(instance, props) {
    setStyle(instance, {
      ...(props.style ?? instance.style),
      display: props.style?.display ?? 'flex',
    })
  },

  unhideTextInstance(textInstance, text) {
    setTextNodeValue(textInstance, text)
  },

  clearContainer(container) {
    for (const child of [...container.childNodes]) {
      removeChildNode(container, child)
      freeLayoutSubtree(child)
    }
  },

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => {},
}

function findRoot(node: DOMElement): DOMElement | null {
  let cur: DOMElement | undefined = node
  while (cur) {
    if (cur.nodeName === 'ink-root') return cur
    cur = cur.parentNode
  }
  return null
}

function freeLayoutSubtree(node: DOMNode): void {
  if (node.nodeName === '#text') return
  if (node.layoutNode) {
    node.layoutNode.freeRecursive()
    node.layoutNode = undefined
  }
}

export const inkReconciler = Reconciler(hostConfig)

export function createInkFiberRoot(
  rootNode: DOMElement,
  onUncaughtError: (error: unknown) => void = err => {
    throw err
  },
): Reconciler.OpaqueRoot {
  return inkReconciler.createContainer(
    rootNode,
    ConcurrentRoot,
    null,
    false,
    null,
    'ink-',
    err => onUncaughtError(err),
    () => {},
    () => {},
    () => {},
    null,
  )
}
