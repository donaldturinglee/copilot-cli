import {
  Align,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Node as YogaNode,
  Overflow,
  PositionType,
  Wrap,
  YOGA_INSTANCE,
} from '../../../native/yoga_layout/index.js'
import type { Styles } from '../styles.js'
import type {
  ComputedLayout,
  LayoutMeasureFunc,
  LayoutMeasureMode,
  LayoutNode,
} from './node.js'

function toMeasureMode(mode: MeasureMode): LayoutMeasureMode {
  if (mode === MeasureMode.Exactly) return 'exactly'
  if (mode === MeasureMode.AtMost) return 'at-most'
  return 'undefined'
}

function mapFlexDirection(
  dir: Styles['flexDirection'],
): FlexDirection {
  switch (dir) {
    case 'row':
      return FlexDirection.Row
    case 'row-reverse':
      return FlexDirection.RowReverse
    case 'column-reverse':
      return FlexDirection.ColumnReverse
    default:
      return FlexDirection.Column
  }
}

function mapAlign(align: Styles['alignItems'] | Styles['alignSelf'] | Styles['alignContent']): Align {
  switch (align) {
    case 'flex-start':
      return Align.FlexStart
    case 'center':
      return Align.Center
    case 'flex-end':
      return Align.FlexEnd
    case 'stretch':
      return Align.Stretch
    case 'baseline':
      return Align.Baseline
    case 'space-between':
      return Align.SpaceBetween
    case 'space-around':
      return Align.SpaceAround
    case 'space-evenly':
      return Align.SpaceEvenly
    default:
      return Align.Auto
  }
}

function mapJustify(justify: Styles['justifyContent']): Justify {
  switch (justify) {
    case 'center':
      return Justify.Center
    case 'flex-end':
      return Justify.FlexEnd
    case 'space-between':
      return Justify.SpaceBetween
    case 'space-around':
      return Justify.SpaceAround
    case 'space-evenly':
      return Justify.SpaceEvenly
    default:
      return Justify.FlexStart
  }
}

function mapWrap(wrap: Styles['flexWrap']): Wrap {
  switch (wrap) {
    case 'wrap':
      return Wrap.Wrap
    case 'wrap-reverse':
      return Wrap.WrapReverse
    default:
      return Wrap.NoWrap
  }
}

function mapOverflow(overflow: Styles['overflow']): Overflow {
  switch (overflow) {
    case 'hidden':
      return Overflow.Hidden
    case 'scroll':
      return Overflow.Scroll
    default:
      return Overflow.Visible
  }
}

function mapPositionType(position: Styles['position']): PositionType {
  switch (position) {
    case 'absolute':
      return PositionType.Absolute
    case 'static':
      return PositionType.Static
    default:
      return PositionType.Relative
  }
}

function mapDisplay(display: Styles['display']): Display {
  switch (display) {
    case 'none':
      return Display.None
    case 'contents':
      return Display.Contents
    default:
      return Display.Flex
  }
}

export class YogaLayoutNode implements LayoutNode {
  readonly yogaNode: YogaNode

  constructor() {
    this.yogaNode = YOGA_INSTANCE.Node.create()
  }

  insertChild(child: LayoutNode, index: number): void {
    if (child instanceof YogaLayoutNode) {
      this.yogaNode.insertChild(child.yogaNode, index)
    }
  }

  removeChild(child: LayoutNode): void {
    if (child instanceof YogaLayoutNode) {
      this.yogaNode.removeChild(child.yogaNode)
    }
  }

  getChildCount(): number {
    return this.yogaNode.getChildCount()
  }

  applyStyles(styles: Styles): void {
    const n = this.yogaNode

    n.setDisplay(mapDisplay(styles.display))
    n.setPositionType(mapPositionType(styles.position))
    n.setPosition(Edge.Top, styles.top)
    n.setPosition(Edge.Bottom, styles.bottom)
    n.setPosition(Edge.Left, styles.left)
    n.setPosition(Edge.Right, styles.right)

    n.setFlexDirection(mapFlexDirection(styles.flexDirection))
    n.setFlexWrap(mapWrap(styles.flexWrap))
    n.setFlexGrow(styles.flexGrow ?? 0)
    n.setFlexShrink(styles.flexShrink ?? 1)
    if (styles.flexBasis !== undefined) {
      n.setFlexBasis(styles.flexBasis)
    } else {
      n.setFlexBasisAuto()
    }

    n.setAlignItems(
      styles.alignItems ? mapAlign(styles.alignItems) : Align.Stretch,
    )
    n.setAlignSelf(styles.alignSelf ? mapAlign(styles.alignSelf) : Align.Auto)
    n.setAlignContent(
      styles.alignContent ? mapAlign(styles.alignContent) : Align.FlexStart,
    )
    n.setJustifyContent(mapJustify(styles.justifyContent))

    n.setWidth(styles.width === undefined ? 'auto' : styles.width)
    n.setHeight(styles.height === undefined ? 'auto' : styles.height)
    n.setMinWidth(styles.minWidth)
    n.setMinHeight(styles.minHeight)
    n.setMaxWidth(styles.maxWidth)
    n.setMaxHeight(styles.maxHeight)

    const overflow = styles.overflowY ?? styles.overflowX ?? styles.overflow
    n.setOverflow(mapOverflow(overflow))

    // Margins
    n.setMargin(Edge.All, styles.margin)
    n.setMargin(Edge.Horizontal, styles.marginX)
    n.setMargin(Edge.Vertical, styles.marginY)
    n.setMargin(Edge.Top, styles.marginTop)
    n.setMargin(Edge.Bottom, styles.marginBottom)
    n.setMargin(Edge.Left, styles.marginLeft)
    n.setMargin(Edge.Right, styles.marginRight)

    // Padding
    n.setPadding(Edge.All, styles.padding)
    n.setPadding(Edge.Horizontal, styles.paddingX)
    n.setPadding(Edge.Vertical, styles.paddingY)
    n.setPadding(Edge.Top, styles.paddingTop)
    n.setPadding(Edge.Bottom, styles.paddingBottom)
    n.setPadding(Edge.Left, styles.paddingLeft)
    n.setPadding(Edge.Right, styles.paddingRight)

    // Gap
    n.setGap(Gutter.All, styles.gap)
    n.setGap(Gutter.Column, styles.columnGap)
    n.setGap(Gutter.Row, styles.rowGap)

    // Borders
    if (styles.borderStyle) {
      n.setBorder(Edge.Top, styles.borderTop === false ? 0 : 1)
      n.setBorder(Edge.Bottom, styles.borderBottom === false ? 0 : 1)
      n.setBorder(Edge.Left, styles.borderLeft === false ? 0 : 1)
      n.setBorder(Edge.Right, styles.borderRight === false ? 0 : 1)
    } else {
      n.setBorder(Edge.Top, undefined)
      n.setBorder(Edge.Bottom, undefined)
      n.setBorder(Edge.Left, undefined)
      n.setBorder(Edge.Right, undefined)
    }
  }

  setMeasureFunc(fn: LayoutMeasureFunc | null): void {
    if (!fn) {
      this.yogaNode.unsetMeasureFunc()
      return
    }
    this.yogaNode.setMeasureFunc((w, wMode, h, hMode) =>
      fn(w, toMeasureMode(wMode), h, toMeasureMode(hMode)),
    )
  }

  markDirty(): void {
    this.yogaNode.markDirty()
  }

  isDirty(): boolean {
    return this.yogaNode.isDirty()
  }

  calculateLayout(width?: number, height?: number): void {
    this.yogaNode.calculateLayout(width, height)
  }

  getComputedLayout(): ComputedLayout {
    return this.yogaNode.getComputedLayout()
  }

  getComputedLeft(): number {
    return this.yogaNode.getComputedLeft()
  }

  getComputedTop(): number {
    return this.yogaNode.getComputedTop()
  }

  getComputedWidth(): number {
    return this.yogaNode.getComputedWidth()
  }

  getComputedHeight(): number {
    return this.yogaNode.getComputedHeight()
  }

  getComputedPaddingLeft(): number {
    return this.yogaNode.getComputedPadding(Edge.Left)
  }

  getComputedPaddingRight(): number {
    return this.yogaNode.getComputedPadding(Edge.Right)
  }

  getComputedPaddingTop(): number {
    return this.yogaNode.getComputedPadding(Edge.Top)
  }

  getComputedPaddingBottom(): number {
    return this.yogaNode.getComputedPadding(Edge.Bottom)
  }

  getComputedBorderLeft(): number {
    return this.yogaNode.getComputedBorder(Edge.Left)
  }

  getComputedBorderRight(): number {
    return this.yogaNode.getComputedBorder(Edge.Right)
  }

  getComputedBorderTop(): number {
    return this.yogaNode.getComputedBorder(Edge.Top)
  }

  getComputedBorderBottom(): number {
    return this.yogaNode.getComputedBorder(Edge.Bottom)
  }

  free(): void {
    this.yogaNode.free()
  }

  freeRecursive(): void {
    this.yogaNode.freeRecursive()
  }
}
