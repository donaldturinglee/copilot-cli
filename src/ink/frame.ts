import type { Cursor } from './cursor.js'
import { createCursor } from './cursor.js'
import type { Size } from './layout/geometry.js'
import {
  createScreen,
  type Screen,
  type StylePool,
} from './screen.js'

export type FlickerReason = 'resize' | 'offscreen' | 'clear' | 'manual'

export type ScrollHint = {
  /** Top 0-based screen row of the scrolling region (inclusive). */
  top: number
  /** Bottom 0-based screen row of the scrolling region (inclusive). */
  bottom: number
  /** Positive scrolls content up (new rows at bottom), negative scrolls down. */
  delta: number
}

export type FrameEvent =
  | { type: 'flicker'; reason: FlickerReason; desiredHeight: number; actualHeight: number }
  | { type: 'scroll'; delta: number }

export type Patch =
  | { type: 'stdout'; content: string }
  | { type: 'clear'; count: number }
  | { type: 'clearTerminal'; reason: FlickerReason }
  | { type: 'clearLine' }
  | { type: 'carriageReturn' }
  | { type: 'cursorHide' }
  | { type: 'cursorShow' }
  | { type: 'cursorMove'; x: number; y: number }
  | { type: 'cursorTo'; x: number; y: number }
  | { type: 'style'; styleId: number }
  | { type: 'hyperlink'; url: string | undefined }

export type Diff = Patch[]

export type Frame = {
  screen: Screen
  viewport: Size
  cursor: Cursor
  scrollHint?: ScrollHint
  altScreen?: boolean
}

export function createEmptyFrame(
  viewport: Size,
  stylePool: StylePool,
  altScreen = false,
): Frame {
  return {
    screen: createScreen(viewport.width, altScreen ? viewport.height : 0, stylePool),
    viewport: { ...viewport },
    cursor: createCursor(0, 0, false),
    altScreen,
  }
}

export function shouldClearScreen(prev: Frame, next: Frame): FlickerReason | null {
  if (prev.viewport.width !== 0 && next.viewport.width !== prev.viewport.width) {
    return 'resize'
  }
  if (next.viewport.height < prev.viewport.height) {
    return 'resize'
  }
  return null
}
