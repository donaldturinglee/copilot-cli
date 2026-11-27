import cliBoxes from 'cli-boxes'
import type { ThemeName } from '../utilities/theme.js'
import { colorize } from './colorize.js'
import type { DOMElement } from './dom.js'
import type { Rectangle } from './layout/geometry.js'
import type { Output } from './output.js'
import { SGR_DIM, SGR_NO_BOLD_OR_DIM } from './termio/sgr.js'

function applyStyle(
  text: string,
  color: string | undefined,
  dim: boolean | undefined,
  themeName: ThemeName,
): string {
  let out = color ? colorize(text, color, 'foreground', themeName) : text
  if (dim) {
    out = `${SGR_DIM}${out}${SGR_NO_BOLD_OR_DIM}`
  }
  return out
}

export function renderBorder(
  x: number,
  y: number,
  node: DOMElement,
  output: Output,
  themeName: ThemeName,
  clip?: Rectangle,
  noSelect?: boolean,
): void {
  const { style } = node
  if (!style.borderStyle || !node.layoutNode) return

  const width = node.layoutNode.getComputedWidth()
  const height = node.layoutNode.getComputedHeight()
  if (width <= 0 || height <= 0) return

  const box =
    typeof style.borderStyle === 'string'
      ? cliBoxes[style.borderStyle]
      : style.borderStyle

  const showTop = style.borderTop !== false
  const showBottom = style.borderBottom !== false
  const showLeft = style.borderLeft !== false
  const showRight = style.borderRight !== false

  const topColor = style.borderTopColor ?? style.borderColor
  const bottomColor = style.borderBottomColor ?? style.borderColor
  const leftColor = style.borderLeftColor ?? style.borderColor
  const rightColor = style.borderRightColor ?? style.borderColor

  const topDim = style.borderTopDimColor ?? style.borderDimColor
  const bottomDim = style.borderBottomDimColor ?? style.borderDimColor
  const leftDim = style.borderLeftDimColor ?? style.borderDimColor
  const rightDim = style.borderRightDimColor ?? style.borderDimColor

  const innerW = Math.max(0, width - (showLeft ? 1 : 0) - (showRight ? 1 : 0))
  const innerH = Math.max(0, height - (showTop ? 1 : 0) - (showBottom ? 1 : 0))

  if (showTop) {
    const topStr =
      (showLeft ? box.topLeft : '') +
      box.top.repeat(innerW) +
      (showRight ? box.topRight : '')
    output.write(x, y, applyStyle(topStr, topColor, topDim, themeName), {
      clip,
      noSelect,
    })
  }

  if (showLeft && innerH > 0) {
    const leftChar = applyStyle(box.left, leftColor, leftDim, themeName)
    const startY = y + (showTop ? 1 : 0)
    for (let row = 0; row < innerH; row++) {
      output.write(x, startY + row, leftChar, { clip, noSelect })
    }
  }

  if (showRight && innerH > 0) {
    const rightChar = applyStyle(box.right, rightColor, rightDim, themeName)
    const startY = y + (showTop ? 1 : 0)
    const rightX = x + width - 1
    for (let row = 0; row < innerH; row++) {
      output.write(rightX, startY + row, rightChar, { clip, noSelect })
    }
  }

  if (showBottom && height > (showTop ? 1 : 0)) {
    const bottomStr =
      (showLeft ? box.bottomLeft : '') +
      box.bottom.repeat(innerW) +
      (showRight ? box.bottomRight : '')
    output.write(
      x,
      y + height - 1,
      applyStyle(bottomStr, bottomColor, bottomDim, themeName),
      { clip, noSelect },
    )
  }
}
