import type { ThemeName } from '../utilities/theme.js'
import { createCursor, type CursorDeclaration } from './cursor.js'
import type { DOMElement } from './dom.js'
import type { Frame } from './frame.js'
import type { Size } from './layout/geometry.js'
import { NodeCache } from './node_cache.js'
import { renderToScreen } from './render_to_screen.js'
import {
  CharPool,
  createScreen,
  HyperlinkPool,
  type Screen,
  StylePool,
} from './screen.js'
import type { SearchHighlightState } from './search_highlight.js'
import type { SelectionState } from './selection.js'

export type DoubleBufferRendererOptions = {
  themeName?: ThemeName
  altScreen?: boolean
}

/**
 * Double-buffered TUI frame renderer.
 *
 * Maintains two pre-allocated `Screen` buffers sharing the same `CharPool`,
 * `StylePool`, and `HyperlinkPool`. On each render pass, the back buffer is
 * painted from the Yoga-laid-out DOM tree and swapped with the front buffer so
 * `LogUpdate` can diff `prevFrame` vs `nextFrame` with 64-bit cell equality.
 */
export class DoubleBufferRenderer {
  readonly charPool = new CharPool()
  readonly stylePool = new StylePool()
  readonly hyperlinkPool = new HyperlinkPool()
  readonly nodeCache = new NodeCache()

  private frontScreen: Screen
  private backScreen: Screen
  private frontFrame: Frame
  private themeName: ThemeName
  private altScreen: boolean

  constructor(
    initialViewport: Size,
    options: DoubleBufferRendererOptions = {},
  ) {
    this.themeName = options.themeName ?? 'dark'
    this.altScreen = options.altScreen ?? false
    const initH = this.altScreen ? initialViewport.height : 0
    this.frontScreen = createScreen(
      initialViewport.width,
      initH,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.backScreen = createScreen(
      initialViewport.width,
      initH,
      this.stylePool,
      this.charPool,
      this.hyperlinkPool,
    )
    this.frontFrame = {
      screen: this.frontScreen,
      viewport: { ...initialViewport },
      cursor: createCursor(0, 0, false),
      altScreen: this.altScreen,
    }
  }

  get currentFrame(): Frame {
    return this.frontFrame
  }

  setTheme(themeName: ThemeName): void {
    this.themeName = themeName
  }

  setAltScreen(altScreen: boolean): void {
    this.altScreen = altScreen
  }

  /**
   * Render `root` into the back buffer, swap front/back buffers, and return
   * both `(prevFrame, nextFrame)` for incremental terminal diffing.
   */
  render(
    root: DOMElement,
    viewport: Size,
    extras?: {
      cursorDeclaration?: CursorDeclaration | null
      selection?: SelectionState
      selectionBgSgr?: string
      searchHighlight?: SearchHighlightState
    },
  ): { prevFrame: Frame; nextFrame: Frame } {
    this.nodeCache.nextFrame()

    const prevFrame = this.frontFrame
    const targetScreen = this.backScreen

    const result = renderToScreen(root, targetScreen, viewport.width, {
      themeName: this.themeName,
      nodeCache: this.nodeCache,
      altScreen: this.altScreen,
      viewportHeight: viewport.height,
      selection: extras?.selection,
      selectionBgSgr: extras?.selectionBgSgr,
      searchHighlight: extras?.searchHighlight,
    })

    const declared = extras?.cursorDeclaration
    const cursor = declared
      ? createCursor(declared.x, declared.y, declared.visible, declared.shape)
      : createCursor(0, result.height, false)

    const nextFrame: Frame = {
      screen: targetScreen,
      viewport: { ...viewport },
      cursor,
      scrollHint: result.scrollHint,
      altScreen: this.altScreen,
    }

    // Swap front and back buffers
    this.backScreen = this.frontScreen
    this.frontScreen = targetScreen
    this.frontFrame = nextFrame

    return { prevFrame, nextFrame }
  }
}
