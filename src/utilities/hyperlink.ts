const OSC8_START = '\x1b]8;;'
const OSC8_SEP = '\x07'
const OSC8_END = '\x1b]8;;\x07'

/**
 * Check whether the current terminal environment likely supports OSC 8 hyperlinks.
 */
export function terminalSupportsHyperlinks(): boolean {
  if (process.env.FORCE_HYPERLINK === '1') return true
  if (process.env.FORCE_HYPERLINK === '0') return false
  if (process.env.NO_COLOR !== undefined) return false

  const termProgram = (process.env.TERM_PROGRAM ?? '').toLowerCase()
  if (
    termProgram.includes('iterm') ||
    termProgram.includes('wezterm') ||
    termProgram.includes('vscode') ||
    termProgram.includes('ghostty') ||
    termProgram.includes('kitty') ||
    termProgram.includes('hyper')
  ) {
    return true
  }
  if (process.env.WT_SESSION || process.env.KITTY_WINDOW_ID || process.env.VTE_VERSION) {
    return true
  }
  return false
}

/**
 * Wrap display text in an OSC 8 terminal hyperlink escape sequence.
 */
export function createHyperlink(url: string, label?: string): string {
  const text = label ?? url
  if (!terminalSupportsHyperlinks()) {
    return text
  }
  return `${OSC8_START}${url}${OSC8_SEP}${text}${OSC8_END}`
}

/**
 * Unconditionally format an OSC 8 hyperlink sequence regardless of environment.
 */
export function formatOsc8Hyperlink(url: string, label?: string): string {
  return `${OSC8_START}${url}${OSC8_SEP}${label ?? url}${OSC8_END}`
}
