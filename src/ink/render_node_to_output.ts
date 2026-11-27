import type { ThemeName } from '../utilities/theme.js'
import { resolveColorToSgr } from './colorize.js'
import type { DOMElement } from './dom.js'
import type { ScrollHint } from './frame.js'
import { getMaxWidth } from './get_max_width.js'
import { type Rectangle } from './layout/geometry.js'
import type { NodeCache } from './node_cache.js'
import type { Output } from './output.js'
import { renderBorder } from './render_border.js'
import { squashTextNodes } from './squash_text_nodes.js'
import { expandTabs } from './tabstops.js'
import { wrapTextWithMetadata } from './wrap_text.js'

export type RenderNodeContext = {
  themeName: ThemeName
  nodeCache?: NodeCache
  scrollHints: ScrollHint[]
}

export function renderNodeToOutput(
  node: DOMElement,
  output: Output,
  options: {
    offsetX?: number
    offsetY?: number
    noSelect?: boolean
    context: RenderNodeContext
  },
): void {
  const { offsetX = 0, offsetY = 0, context } = options
  const noSelect = Boolean(options.noSelect || node.style.noSelect)

  if (node.style.display === 'none') return

  const layoutNode = node.layoutNode
  if (!layoutNode) return

  const x = offsetX + layoutNode.getComputedLeft()
  const y = offsetY + layoutNode.getComputedTop()
  const width = layoutNode.getComputedWidth()
  const height = layoutNode.getComputedHeight()

  const rect: Rectangle = { x, y, width, height }
  node.internal_lastRect = rect
  context.nodeCache?.set(node, rect)

  if (node.style.noSelect) {
    output.markNoSelect(
      x,
      y,
      width,
      height,
      Boolean(node.style.noSelectFromLeftEdge),
    )
  }

  // Raw ANSI pre-formatted leaf (O(1) Yoga leaf used by StructuredDiff / HighlightedCode)
  if (node.nodeName === 'ink-raw-ansi') {
    const lines = node.internal_rawAnsiLines ?? []
    for (let i = 0; i < lines.length; i++) {
      output.write(x, y + i, lines[i]!, { noSelect })
    }
    node.dirty = false
    return
  }

  // Text leaf
  if (node.nodeName === 'ink-text') {
    let text = expandTabs(squashTextNodes(node))
    if (text.length > 0) {
      const maxWidth = Math.max(1, getMaxWidth(layoutNode))
      const wrapped = wrapTextWithMetadata(
        text,
        maxWidth,
        node.style.textWrap ?? 'wrap',
      )
      const joined = wrapped.map(l => l.text).join('\n')
      const softWrapFlags = wrapped.map(l => l.softWrapped)
      let finalText = joined
      if (node.internal_transform) {
        finalText = node.internal_transform(finalText, 0)
      }
      output.write(x, y, finalText, { noSelect, softWrapFlags })
    }
    node.dirty = false
    return
  }

  // Box / Root / ScrollBox container
  const bgSgr = resolveColorToSgr(
    node.style.backgroundColor,
    'background',
    context.themeName,
  )
  if (bgSgr && width > 0 && height > 0) {
    output.fillBackground(x, y, width, height, bgSgr, undefined, noSelect)
  }

  const clipOverflow =
    node.nodeName === 'ink-scroll-box' ||
    node.style.overflow === 'hidden' ||
    node.style.overflow === 'scroll' ||
    node.style.overflowX === 'hidden' ||
    node.style.overflowY === 'hidden' ||
    node.style.overflowY === 'scroll'

  const padL = layoutNode.getComputedBorderLeft()
  const padT = layoutNode.getComputedBorderTop()
  const padR = layoutNode.getComputedBorderRight()
  const padB = layoutNode.getComputedBorderBottom()

  let childOffsetY = y

  if (node.nodeName === 'ink-scroll-box' && node.internal_scrollState) {
    const st = node.internal_scrollState
    const viewportH = Math.max(0, height - padT - padB)
    let maxChildBottom = 0
    for (const child of node.childNodes) {
      if (child.nodeName === '#text' || !child.layoutNode) continue
      const bottom =
        child.layoutNode.getComputedTop() + child.layoutNode.getComputedHeight()
      if (bottom > maxChildBottom) maxChildBottom = bottom
    }
    st.contentHeight = maxChildBottom
    st.viewportHeight = viewportH
    const maxScroll = Math.max(0, maxChildBottom - viewportH)
    if (st.stickyBottom) {
      st.scrollTop = maxScroll
    } else {
      st.scrollTop = Math.max(0, Math.min(st.scrollTop, maxScroll))
    }

    const delta = st.scrollTop - st.prevScrollTop
    if (delta !== 0 && viewportH > 0) {
      const topRow = Math.max(0, Math.floor(y + padT))
      const bottomRow = Math.min(
        output.height - 1,
        Math.floor(y + padT + viewportH - 1),
      )
      if (bottomRow >= topRow) {
        context.scrollHints.push({ top: topRow, bottom: bottomRow, delta })
      }
    }
    st.prevScrollTop = st.scrollTop
    childOffsetY = y - st.scrollTop
  }

  if (clipOverflow) {
    output.pushClip({
      x: x + padL,
      y: y + padT,
      width: Math.max(0, width - padL - padR),
      height: Math.max(0, height - padT - padB),
    })
  }

  for (const child of node.childNodes) {
    if (child.nodeName === '#text') continue
    renderNodeToOutput(child, output, {
      offsetX: x,
      offsetY: childOffsetY,
      noSelect,
      context,
    })
  }

  if (clipOverflow) {
    output.popClip()
  }

  if (node.style.borderStyle) {
    renderBorder(x, y, node, output, context.themeName, undefined, noSelect)
  }

  node.dirty = false
}
