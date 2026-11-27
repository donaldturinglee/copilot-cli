import { CSI } from './ansi.js'

/**
 * DEC private mode constants and builders (DECSET / DECRST / DECRQM).
 */

export const DEC_MODE = {
  CURSOR_KEYS: 1,
  DECAWM_AUTO_WRAP: 7,
  CURSOR_VISIBLE: 25,
  MOUSE_X10: 1000,
  MOUSE_BUTTON_EVENT: 1002,
  MOUSE_ANY_EVENT: 1003,
  FOCUS_EVENTS: 1004,
  MOUSE_SGR_EXT: 1006,
  ALT_SCREEN_BUFFER: 1049,
  BRACKETED_PASTE: 2004,
  SYNCHRONIZED_OUTPUT: 2026,
} as const

export type DecMode = (typeof DEC_MODE)[keyof typeof DEC_MODE]

export function decSet(mode: number): string {
  return `${CSI}?${mode}h`
}

export function decReset(mode: number): string {
  return `${CSI}?${mode}l`
}

export function decQuery(mode: number): string {
  return `${CSI}?${mode}$p`
}

// Commonly used pre-built sequences
export const CURSOR_SHOW = decSet(DEC_MODE.CURSOR_VISIBLE)
export const CURSOR_HIDE = decReset(DEC_MODE.CURSOR_VISIBLE)

export const ENTER_ALT_SCREEN = decSet(DEC_MODE.ALT_SCREEN_BUFFER)
export const EXIT_ALT_SCREEN = decReset(DEC_MODE.ALT_SCREEN_BUFFER)

export const ENABLE_BRACKETED_PASTE = decSet(DEC_MODE.BRACKETED_PASTE)
export const DISABLE_BRACKETED_PASTE = decReset(DEC_MODE.BRACKETED_PASTE)

export const ENABLE_FOCUS_EVENTS = decSet(DEC_MODE.FOCUS_EVENTS)
export const DISABLE_FOCUS_EVENTS = decReset(DEC_MODE.FOCUS_EVENTS)

/** DEC 2026 Begin / End Synchronized Update (BSU / ESU) */
export const BSU = decSet(DEC_MODE.SYNCHRONIZED_OUTPUT)
export const ESU = decReset(DEC_MODE.SYNCHRONIZED_OUTPUT)

export const ENABLE_MOUSE_TRACKING =
  decSet(DEC_MODE.MOUSE_X10) +
  decSet(DEC_MODE.MOUSE_BUTTON_EVENT) +
  decSet(DEC_MODE.MOUSE_SGR_EXT)

export const DISABLE_MOUSE_TRACKING =
  decReset(DEC_MODE.MOUSE_SGR_EXT) +
  decReset(DEC_MODE.MOUSE_BUTTON_EVENT) +
  decReset(DEC_MODE.MOUSE_X10)
