/**
 * Expand tab characters (`\t`) to column-aligned spaces per line so cell widths
 * remain deterministic inside the screen buffer.
 */
export function expandTabs(text: string, tabWidth = 4): string {
  if (!text.includes('\t')) return text
  const step = Math.max(1, tabWidth)
  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    if (!line.includes('\t')) continue
    let out = ''
    let col = 0
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '\t') {
        const spaces = step - (col % step)
        out += ' '.repeat(spaces)
        col += spaces
      } else {
        out += ch
        col++
      }
    }
    lines[li] = out
  }
  return lines.join('\n')
}
