import { BEL, OSC } from './ansi.js'

/**
 * OSC (Operating System Command) sequence builders:
 * - OSC 0 / 2: window/tab title
 * - OSC 8: hyperlinks
 * - OSC 9;4: Windows Terminal / ConEmu progress indicator
 * - OSC 11: background color query
 * - OSC 52: clipboard read/write
 */

export const LINK_END = `${OSC}8;;${BEL}`

/**
 * Build an OSC 8 hyperlink opening sequence.
 */
export function link(url: string, params = ''): string {
  return `${OSC}8;${params};${url}${BEL}`
}

/**
 * Wrap text in OSC 8 hyperlink open + close sequences.
 */
export function hyperlink(url: string, label: string, params = ''): string {
  return `${link(url, params)}${label}${LINK_END}`
}

/**
 * Build an OSC 0 title sequence.
 */
export function setTitle(title: string): string {
  // Sanitize control bytes that could terminate OSC early
  const clean = title.replace(/[\x00-\x1f\x7f]/g, '')
  return `${OSC}0;${clean}${BEL}`
}

/**
 * Build an OSC 52 clipboard write sequence (base64 encoded UTF-8).
 */
export function setClipboard(text: string, selection = 'c'): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return `${OSC}52;${selection};${encoded}${BEL}`
}

export const PROGRESS_STATE = {
  HIDDEN: 0,
  NORMAL: 1,
  ERROR: 2,
  INDETERMINATE: 3,
  WARNING: 4,
} as const

export type ProgressState = (typeof PROGRESS_STATE)[keyof typeof PROGRESS_STATE]

/**
 * Build an OSC 9;4 terminal progress indicator sequence.
 */
export function setProgress(state: ProgressState, percent?: number): string {
  if (percent === undefined || state === PROGRESS_STATE.HIDDEN || state === PROGRESS_STATE.INDETERMINATE) {
    return `${OSC}9;4;${state}${BEL}`
  }
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  return `${OSC}9;4;${state};${clamped}${BEL}`
}

/**
 * Query terminal background color via OSC 11.
 */
export const QUERY_BACKGROUND_COLOR = `${OSC}11;?${BEL}`

/**
 * Emit desktop/terminal notification via OSC 9 (iTerm2 / Ghostty / WezTerm).
 */
export function notifyOsc9(message: string): string {
  const clean = message.replace(/[\x00-\x1f\x7f]/g, '')
  return `${OSC}9;${clean}${BEL}`
}
