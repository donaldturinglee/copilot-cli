import type React from 'react'
import { createRoot, type InkInstance, render } from '../ink/root.js'
import type { InkRenderOptions } from './render_options.js'

export function mountInkApp(
  element: React.ReactNode,
  options: InkRenderOptions = {},
): InkInstance {
  return render(element, options)
}

export { createRoot, render, type InkInstance }
