export type CursorShape =
  | 'default'
  | 'block'
  | 'underline'
  | 'bar'
  | 'blinkingBlock'
  | 'blinkingUnderline'
  | 'blinkingBar'

export type Cursor = {
  x: number
  y: number
  visible: boolean
  shape?: CursorShape
}

export type CursorDeclaration = {
  x: number
  y: number
  visible: boolean
  shape?: CursorShape
}

export function createCursor(
  x = 0,
  y = 0,
  visible = false,
  shape?: CursorShape,
): Cursor {
  return { x, y, visible, shape }
}
