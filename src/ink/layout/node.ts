import type { Styles } from '../styles.js'

export type LayoutMeasureMode = 'undefined' | 'exactly' | 'at-most'

export type LayoutMeasureFunc = (
  width: number,
  widthMode: LayoutMeasureMode,
  height: number,
  heightMode: LayoutMeasureMode,
) => { width: number; height: number }

export type ComputedLayout = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface LayoutNode {
  insertChild(child: LayoutNode, index: number): void
  removeChild(child: LayoutNode): void
  getChildCount(): number
  applyStyles(styles: Styles): void
  setMeasureFunc(fn: LayoutMeasureFunc | null): void
  markDirty(): void
  isDirty(): boolean
  calculateLayout(width?: number, height?: number): void
  getComputedLayout(): ComputedLayout
  getComputedLeft(): number
  getComputedTop(): number
  getComputedWidth(): number
  getComputedHeight(): number
  getComputedPaddingLeft(): number
  getComputedPaddingRight(): number
  getComputedPaddingTop(): number
  getComputedPaddingBottom(): number
  getComputedBorderLeft(): number
  getComputedBorderRight(): number
  getComputedBorderTop(): number
  getComputedBorderBottom(): number
  free(): void
  freeRecursive(): void
}
