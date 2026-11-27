import { setTitle as oscSetTitle } from '../ink/termio/osc.js'

export type TerminalCapabilities = {
  isTTY: boolean
  columns: number
  rows: number
  supportsTruecolor: boolean
  supports256Color: boolean
  supportsKittyKeyboard: boolean
  supportsSyncOutput: boolean
  termProgram: string | undefined
  isTmux: boolean
  isWindowsTerminal: boolean
}

export function getTerminalSize(): { columns: number; rows: number } {
  const columns =
    process.stdout && typeof process.stdout.columns === 'number' && process.stdout.columns > 0
      ? process.stdout.columns
      : 80
  const rows =
    process.stdout && typeof process.stdout.rows === 'number' && process.stdout.rows > 0
      ? process.stdout.rows
      : 24
  return { columns, rows }
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  const { columns, rows } = getTerminalSize()
  const colorterm = (process.env.COLORTERM ?? '').toLowerCase()
  const term = (process.env.TERM ?? '').toLowerCase()
  const termProgram = process.env.TERM_PROGRAM
  const isTmux = Boolean(process.env.TMUX)
  const isWindowsTerminal = Boolean(process.env.WT_SESSION)

  const supportsTruecolor =
    colorterm === 'truecolor' ||
    colorterm === '24bit' ||
    isWindowsTerminal ||
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'ghostty' ||
    termProgram === 'vscode'

  const supports256Color =
    supportsTruecolor || term.includes('256color') || term.includes('xterm')

  const supportsKittyKeyboard =
    Boolean(process.env.KITTY_WINDOW_ID) ||
    termProgram === 'WezTerm' ||
    termProgram === 'ghostty' ||
    termProgram === 'iTerm.app'

  const supportsSyncOutput =
    !isTmux &&
    (supportsKittyKeyboard || isWindowsTerminal || termProgram === 'vscode')

  return {
    isTTY: Boolean(process.stdout?.isTTY),
    columns,
    rows,
    supportsTruecolor,
    supports256Color,
    supportsKittyKeyboard,
    supportsSyncOutput,
    termProgram,
    isTmux,
    isWindowsTerminal,
  }
}

export function setTerminalTitle(
  title: string,
  stream: NodeJS.WriteStream = process.stdout,
): void {
  if (stream.isTTY) {
    stream.write(oscSetTitle(title))
  }
}
