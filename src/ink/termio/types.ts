/**
 * Core terminal I/O protocol types for streaming VT tokenization and semantic parsing.
 */

export type Token =
  | { type: 'text'; value: string }
  | { type: 'sequence'; value: string }

export type ColorSpec =
  | { type: 'default' }
  | { type: 'ansi'; index: number }
  | { type: 'ansi256'; index: number }
  | { type: 'rgb'; r: number; g: number; b: number }

export type TextAttributes = {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  blink?: boolean
  inverse?: boolean
  hidden?: boolean
  strikethrough?: boolean
  foreground?: ColorSpec
  background?: ColorSpec
}

export type SemanticEvent =
  | { type: 'text'; value: string }
  | { type: 'sgr'; params: number[] }
  | { type: 'csi'; prefix: string; params: number[]; intermediates: string; final: string; raw: string }
  | { type: 'osc'; code: number; data: string; raw: string }
  | { type: 'dcs'; content: string; raw: string }
  | { type: 'esc'; intermediates: string; final: string; raw: string }
  | { type: 'ctrl'; code: number; raw: string }
  | { type: 'hyperlink'; url: string | null; params: string }
  | { type: 'clipboard'; selection: string; data: string }
  | { type: 'progress'; state: number; percent?: number }
  | { type: 'focus'; focused: boolean }
  | { type: 'pasteStart' }
  | { type: 'pasteEnd' }
  | { type: 'syncStart' }
  | { type: 'syncEnd' }
