export type PlatformModifierStyle = 'mac' | 'standard'

export function getModifierDisplayStyle(): PlatformModifierStyle {
  return process.platform === 'darwin' ? 'mac' : 'standard'
}

/**
 * Format a canonical shortcut string (e.g. "ctrl+shift+p", "meta+t", "ctrl+x ctrl+e")
 * into a concise human-readable terminal hint.
 */
export function formatShortcutHint(
  shortcut: string,
  style: PlatformModifierStyle = getModifierDisplayStyle(),
): string {
  const steps = shortcut.trim().split(/\s+/).filter(Boolean)
  return steps
    .map(step => {
      const parts = step.split('+').map(p => p.trim().toLowerCase())
      return parts
        .map(part => {
          switch (part) {
            case 'ctrl':
            case 'control':
              return 'ctrl'
            case 'meta':
            case 'alt':
            case 'opt':
            case 'option':
              return style === 'mac' ? '⌥' : 'alt'
            case 'cmd':
            case 'command':
            case 'super':
              return style === 'mac' ? '⌘' : 'super'
            case 'shift':
              return 'shift'
            case 'escape':
            case 'esc':
              return 'esc'
            case 'return':
            case 'enter':
              return 'enter'
            case 'space':
              return 'space'
            case 'up':
              return '↑'
            case 'down':
              return '↓'
            case 'left':
              return '←'
            case 'right':
              return '→'
            default:
              return part
          }
        })
        .join('+')
    })
    .join(' ')
}
