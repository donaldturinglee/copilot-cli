import type React from 'react'
import { createNode } from '../ink/dom.js'
import { LogUpdate } from '../ink/log_update.js'
import { createInkFiberRoot, inkReconciler } from '../ink/reconciler.js'
import { renderToScreen } from '../ink/render_to_screen.js'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  screenToPlainLines,
  StylePool,
} from '../ink/screen.js'
import type { ThemeName } from './theme.js'

export type StaticRenderOptions = {
  columns?: number
  rows?: number
  themeName?: ThemeName
  altScreen?: boolean
  stripAnsi?: boolean
}

export type StaticRenderSnapshot = {
  ansi: string
  plain: string
  lines: string[]
  screen: Screen
}

/**
 * Synchronously render a React element tree offscreen into a packed `Screen`
 * buffer and return ANSI string, plain text, and raw cell buffer snapshot.
 */
export function renderToScreenSnapshot(
  element: React.ReactNode,
  options: StaticRenderOptions = {},
): StaticRenderSnapshot {
  const columns = Math.max(1, options.columns ?? 80)
  const rows = Math.max(1, options.rows ?? 24)
  const themeName = options.themeName ?? 'dark'
  const altScreen = options.altScreen ?? false

  const rootNode = createNode('ink-root')
  const fiberRoot = createInkFiberRoot(rootNode)

  inkReconciler.updateContainerSync(element, fiberRoot, null, null)
  inkReconciler.flushSyncWork()

  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const screen = createScreen(columns, altScreen ? rows : 0, stylePool, charPool, hyperlinkPool)

  renderToScreen(rootNode, screen, columns, {
    themeName,
    altScreen,
    viewportHeight: rows,
  })

  const logUpdate = new LogUpdate({ isTTY: false, stylePool })
  const patches = logUpdate.renderFullFrame({
    screen,
    viewport: { width: columns, height: rows },
    cursor: { x: 0, y: screen.height, visible: false },
    altScreen,
  })
  const ansi = patches
    .filter((p): p is { type: 'stdout'; content: string } => p.type === 'stdout')
    .map(p => p.content)
    .join('')

  const lines = screenToPlainLines(screen)
  const plain = lines.join('\n')

  inkReconciler.updateContainerSync(null, fiberRoot, null, null)
  inkReconciler.flushSyncWork()

  return { ansi, plain, lines, screen }
}

/**
 * Synchronously render a React element tree to a terminal string.
 */
export function renderToString(
  element: React.ReactNode,
  options: StaticRenderOptions = {},
): string {
  const snapshot = renderToScreenSnapshot(element, options)
  return options.stripAnsi ? snapshot.plain : snapshot.ansi
}
