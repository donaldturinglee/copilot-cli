import type { Boxes } from 'cli-boxes'
import type { Theme } from '../utilities/theme.js'

export type ColorValue =
  | keyof Theme
  | `rgb(${number},${number},${number})`
  | `ansi:${string}`
  | `#${string}`
  | (string & {})

export type BorderStyle =
  | keyof Boxes
  | {
      topLeft: string
      top: string
      topRight: string
      left: string
      right: string
      bottomLeft: string
      bottom: string
      bottomRight: string
    }

export type TextWrapMode =
  | 'wrap'
  | 'end'
  | 'middle'
  | 'truncate-end'
  | 'truncate'
  | 'truncate-middle'
  | 'truncate-start'

export type Styles = {
  textWrap?: TextWrapMode
  position?: 'absolute' | 'relative' | 'static'
  top?: number | string
  bottom?: number | string
  left?: number | string
  right?: number | string
  columnGap?: number
  rowGap?: number
  gap?: number
  margin?: number | 'auto'
  marginX?: number | 'auto'
  marginY?: number | 'auto'
  marginTop?: number | 'auto'
  marginBottom?: number | 'auto'
  marginLeft?: number | 'auto'
  marginRight?: number | 'auto'
  padding?: number
  paddingX?: number
  paddingY?: number
  paddingTop?: number
  paddingBottom?: number
  paddingLeft?: number
  paddingRight?: number
  flexGrow?: number
  flexShrink?: number
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  flexBasis?: number | string
  flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'
  alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch' | 'baseline'
  alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto' | 'stretch' | 'baseline'
  alignContent?:
    | 'flex-start'
    | 'center'
    | 'flex-end'
    | 'stretch'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
  justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
    | 'center'
  width?: number | string
  height?: number | string
  minWidth?: number | string
  minHeight?: number | string
  maxWidth?: number | string
  maxHeight?: number | string
  display?: 'flex' | 'none' | 'contents'
  overflow?: 'visible' | 'hidden' | 'scroll'
  overflowX?: 'visible' | 'hidden' | 'scroll'
  overflowY?: 'visible' | 'hidden' | 'scroll'
  borderStyle?: BorderStyle
  borderTop?: boolean
  borderBottom?: boolean
  borderLeft?: boolean
  borderRight?: boolean
  borderColor?: ColorValue
  borderTopColor?: ColorValue
  borderBottomColor?: ColorValue
  borderLeftColor?: ColorValue
  borderRightColor?: ColorValue
  borderDimColor?: boolean
  borderTopDimColor?: boolean
  borderBottomDimColor?: boolean
  borderLeftDimColor?: boolean
  borderRightDimColor?: boolean
  backgroundColor?: ColorValue
  /** Mark box subtree as non-selectable during terminal drag selection. */
  noSelect?: boolean
  /** Extend noSelect all the way to the left edge of the screen. */
  noSelectFromLeftEdge?: boolean
}
