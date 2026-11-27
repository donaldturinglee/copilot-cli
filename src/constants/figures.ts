const isDarwin = process.platform === 'darwin'
const isUnicodeSupported =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.TERMINUS_SUBLIME) ||
  process.env.TERM_PROGRAM === 'vscode' ||
  process.env.TERM === 'xterm-256color' ||
  process.env.TERM === 'alacritty'

export const BLACK_CIRCLE = isDarwin ? '⏺' : '●'
export const BULLET_OPERATOR = '∙'
export const TEARDROP_ASTERISK = '✻'
export const UP_ARROW = '\u2191'
export const DOWN_ARROW = '\u2193'
export const LIGHTNING_BOLT = '↯'
export const EFFORT_LOW = '○'
export const EFFORT_MEDIUM = '◐'
export const EFFORT_HIGH = '●'
export const EFFORT_MAX = '◉'

export const PLAY_ICON = '\u25b6'
export const PAUSE_ICON = '\u23f8'
export const REFRESH_ARROW = '\u21bb'
export const CHANNEL_ARROW = '\u2190'
export const INJECTED_ARROW = '\u2192'
export const FORK_GLYPH = '\u2442'

export const DIAMOND_OPEN = '\u25c7'
export const DIAMOND_FILLED = '\u25c6'
export const REFERENCE_MARK = '\u203b'
export const FLAG_ICON = '\u2691'
export const BLOCKQUOTE_BAR = '\u258e'
export const HEAVY_HORIZONTAL = '\u2501'

export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
] as const
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'

/**
 * Cross-platform Unicode/ASCII glyph table.
 */
export const FIGURES = isUnicodeSupported
  ? {
      tick: '✔',
      cross: '✘',
      info: 'ℹ',
      warning: '⚠',
      pointer: '❯',
      pointerSmall: '›',
      bullet: '●',
      ellipsis: '…',
      radioOn: '◉',
      radioOff: '◯',
      checkboxOn: '☒',
      checkboxOff: '☐',
      squareSmallFilled: '◼',
      arrowUp: '↑',
      arrowDown: '↓',
      arrowLeft: '←',
      arrowRight: '→',
      line: '─',
      triangleDown: '▾',
      triangleRight: '▸',
      triangleUp: '▴',
      circleFilled: '●',
      circleOpen: '○',
      star: '★',
    }
  : {
      tick: '√',
      cross: '×',
      info: 'i',
      warning: '‼',
      pointer: '>',
      pointerSmall: '»',
      bullet: '*',
      ellipsis: '...',
      radioOn: '(*)',
      radioOff: '( )',
      checkboxOn: '[x]',
      checkboxOff: '[ ]',
      squareSmallFilled: '[■]',
      arrowUp: '^',
      arrowDown: 'v',
      arrowLeft: '<',
      arrowRight: '>',
      line: '-',
      triangleDown: 'v',
      triangleRight: '>',
      triangleUp: '^',
      circleFilled: '*',
      circleOpen: 'o',
      star: '*',
    }
