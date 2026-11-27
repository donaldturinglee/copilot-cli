import type { ThemeName } from '../utilities/theme.js'
import type { DOMElement } from './dom.js'
import type { ScrollHint } from './frame.js'
import type { NodeCache } from './node_cache.js'
import { Output } from './output.js'
import { renderNodeToOutput } from './render_node_to_output.js'
import { resetScreen, type Screen } from './screen.js'
import { applySearchHighlights, type SearchHighlightState } from './search_highlight.js'
import { applySelectionOverlay, type SelectionState } from './selection.js'

export type RenderToScreenOptions = {
  themeName?: ThemeName
  nodeCache?: NodeCache
  altScreen?: boolean
  viewportHeight?: number
  selection?: SelectionState
  selectionBgSgr?: string
  searchHighlight?: SearchHighlightState
}

export type RenderToScreenResult = {
  width: number
  height: number
  scrollHint?: ScrollHint
}

/**
 * Lay out `root` into `screen` at `(columns, rows)` and paint all visible nodes
 * plus optional selection and search-highlight overlays.
 */
export function renderToScreen(
  root: DOMElement,
  screen: Screen,
  columns: number,
  options: RenderToScreenOptions = {},
): RenderToScreenResult {
  const safeCols = Math.max(1, Math.floor(columns))
  const altScreen = options.altScreen ?? false
  const viewportH = options.viewportHeight ?? 24

  if (!root.layoutNode) {
    resetScreen(screen, safeCols, altScreen ? viewportH : 0)
    return { width: safeCols, height: screen.height }
  }

  root.layoutNode.calculateLayout(
    safeCols,
    altScreen ? Math.max(1, Math.floor(viewportH)) : undefined,
  )

  const computedH = Math.max(
    0,
    Math.ceil(root.layoutNode.getComputedHeight()),
  )
  const targetHeight = altScreen ? Math.max(1, Math.floor(viewportH)) : computedH

  resetScreen(screen, safeCols, targetHeight)

  const output = new Output(screen)
  const scrollHints: ScrollHint[] = []

  renderNodeToOutput(root, output, {
    offsetX: 0,
    offsetY: 0,
    context: {
      themeName: options.themeName ?? 'dark',
      nodeCache: options.nodeCache,
      scrollHints,
    },
  })

  if (options.searchHighlight && options.searchHighlight.matches.length > 0) {
    applySearchHighlights(screen, options.searchHighlight, screen.stylePool)
  }

  if (options.selection) {
    applySelectionOverlay(
      screen,
      options.selection,
      screen.stylePool,
      options.selectionBgSgr,
    )
  }

  return {
    width: safeCols,
    height: targetHeight,
    scrollHint: scrollHints.length === 1 ? scrollHints[0] : undefined,
  }
}
