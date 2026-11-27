import { EventPhase, type InkEvent } from './event.js'
import {
  type EventHandler,
  type EventHandlerMap,
  getHandlerPropNames,
} from './event_handlers.js'

export type DispatchableNode = {
  parentNode?: DispatchableNode
  eventHandlers?: EventHandlerMap
  eventListeners?: Map<
    string,
    Set<{ handler: EventHandler; capture: boolean }>
  >
}

function invokeNodeListeners(
  node: DispatchableNode,
  event: InkEvent<DispatchableNode>,
  capture: boolean,
): void {
  const props = getHandlerPropNames(event.type)
  if (props && node.eventHandlers) {
    const propName = capture ? props.capture : props.bubble
    const fn = propName
      ? (node.eventHandlers[propName] as EventHandler | undefined)
      : undefined
    if (fn) {
      fn(event)
      if (event.immediatePropagationStopped) return
    }
  }

  const listeners = node.eventListeners?.get(event.type)
  if (listeners) {
    for (const entry of [...listeners]) {
      if (entry.capture !== capture) continue
      entry.handler(event)
      if (event.immediatePropagationStopped) return
    }
  }
}

/**
 * Dispatch an `InkEvent` through the DOM tree following W3C capture -> target -> bubble phases.
 * Returns `false` if `preventDefault()` was invoked, `true` otherwise.
 */
export function dispatchEvent(
  target: DispatchableNode,
  event: InkEvent<DispatchableNode>,
): boolean {
  const path: DispatchableNode[] = []
  let current: DispatchableNode | undefined = target
  while (current) {
    path.push(current)
    current = current.parentNode
  }

  event.target = target

  // 1. Capturing phase (root -> target's parent)
  event.eventPhase = EventPhase.CAPTURING_PHASE
  for (let i = path.length - 1; i >= 1; i--) {
    const node = path[i]!
    event.currentTarget = node
    invokeNodeListeners(node, event, true)
    if (event.propagationStopped) {
      event.eventPhase = EventPhase.NONE
      event.currentTarget = null
      return !event.defaultPrevented
    }
  }

  // 2. At-target phase (capture then bubble handlers on target)
  event.eventPhase = EventPhase.AT_TARGET
  event.currentTarget = target
  invokeNodeListeners(target, event, true)
  if (!event.immediatePropagationStopped) {
    invokeNodeListeners(target, event, false)
  }

  // 3. Bubbling phase (target's parent -> root)
  if (event.bubbles && !event.propagationStopped) {
    event.eventPhase = EventPhase.BUBBLING_PHASE
    for (let i = 1; i < path.length; i++) {
      const node = path[i]!
      event.currentTarget = node
      invokeNodeListeners(node, event, false)
      if (event.propagationStopped) break
    }
  }

  event.eventPhase = EventPhase.NONE
  event.currentTarget = null
  return !event.defaultPrevented
}
