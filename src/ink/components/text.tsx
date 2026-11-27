import React, { createContext, useContext } from 'react'
import { colorize } from '../colorize.js'
import type { ColorValue, TextWrapMode } from '../styles.js'
import {
  SGR_BOLD,
  SGR_DIM,
  SGR_INVERSE,
  SGR_ITALIC,
  SGR_NO_BOLD_OR_DIM,
  SGR_NO_INVERSE,
  SGR_NO_ITALIC,
  SGR_NO_STRIKETHROUGH,
  SGR_NO_UNDERLINE,
  SGR_STRIKETHROUGH,
  SGR_UNDERLINE,
} from '../termio/sgr.js'
import type { ThemeName } from '../../utilities/theme.js'

const InsideTextContext = createContext(false)
export const InkThemeNameContext = createContext<ThemeName>('dark')

export type TextProps = {
  color?: ColorValue
  backgroundColor?: ColorValue
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  wrap?: TextWrapMode
  children?: React.ReactNode
}

export function Text({
  color,
  backgroundColor,
  dimColor = false,
  bold = false,
  italic = false,
  underline = false,
  strikethrough = false,
  inverse = false,
  wrap = 'wrap',
  children,
}: TextProps): React.ReactNode {
  const isInsideText = useContext(InsideTextContext)
  const themeName = useContext(InkThemeNameContext)

  if (children === undefined || children === null) {
    return null
  }

  const transform = (text: string): string => {
    let out = text
    if (color) out = colorize(out, color, 'foreground', themeName)
    if (backgroundColor) {
      out = colorize(out, backgroundColor, 'background', themeName)
    }
    if (dimColor) out = `${SGR_DIM}${out}${SGR_NO_BOLD_OR_DIM}`
    if (bold) out = `${SGR_BOLD}${out}${SGR_NO_BOLD_OR_DIM}`
    if (italic) out = `${SGR_ITALIC}${out}${SGR_NO_ITALIC}`
    if (underline) out = `${SGR_UNDERLINE}${out}${SGR_NO_UNDERLINE}`
    if (strikethrough) {
      out = `${SGR_STRIKETHROUGH}${out}${SGR_NO_STRIKETHROUGH}`
    }
    if (inverse) out = `${SGR_INVERSE}${out}${SGR_NO_INVERSE}`
    return out
  }

  const elementType = isInsideText ? 'ink-virtual-text' : 'ink-text'

  return (
    <InsideTextContext.Provider value={true}>
      {React.createElement(
        elementType,
        {
          style: { textWrap: wrap },
          internal_transform: transform,
        },
        children,
      )}
    </InsideTextContext.Provider>
  )
}
