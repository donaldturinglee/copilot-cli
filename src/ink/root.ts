import type React from 'react'
import type { InkRenderOptions } from '../utilities/render_options.js'
import { Ink } from './ink.js'
import { getInkInstance, setInkInstance } from './instances.js'

export type InkInstance = {
  rerender: (node: React.ReactNode) => void
  unmount: (error?: Error) => void
  waitUntilExit: () => Promise<void>
  clear: () => void
  flush: () => void
  ink: Ink
}

export function createRoot(options: InkRenderOptions = {}): InkInstance {
  const stdout = options.stdout ?? process.stdout
  const existing = getInkInstance<Ink>(stdout)
  if (existing) {
    existing.unmount()
  }

  const ink = new Ink(options)
  setInkInstance(stdout, ink)

  return {
    rerender: node => ink.render(node),
    unmount: error => ink.unmount(error),
    waitUntilExit: () => ink.waitUntilExit(),
    clear: () => ink.clear(),
    flush: () => ink.flushRender(),
    ink,
  }
}

export function render(
  node: React.ReactNode,
  options: InkRenderOptions = {},
): InkInstance {
  const root = createRoot(options)
  root.rerender(node)
  root.flush()
  return root
}
