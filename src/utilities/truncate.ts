import { stringWidth } from '../ink/string_width.js'
import { sliceAnsi } from './slice_ansi.js'

export type TruncatePosition = 'end' | 'middle' | 'start'

export type TruncateOptions = {
  position?: TruncatePosition
  ellipsis?: string
  preferTruncationOnSpace?: boolean
}

/**
 * Truncate a string (plain or ANSI-styled) to fit within `maxWidth` terminal
 * columns, inserting an ellipsis if truncated.
 */
export function truncate(
  text: string,
  maxWidth: number,
  options: TruncateOptions = {},
): string {
  if (maxWidth <= 0) return ''
  const ellipsis = options.ellipsis ?? '…'
  const position = options.position ?? 'end'

  const totalWidth = stringWidth(text)
  if (totalWidth <= maxWidth) {
    return text
  }

  const ellipsisWidth = stringWidth(ellipsis)
  if (maxWidth <= ellipsisWidth) {
    return sliceAnsi(ellipsis, 0, maxWidth)
  }

  const budget = maxWidth - ellipsisWidth

  if (position === 'start') {
    return ellipsis + sliceAnsi(text, totalWidth - budget, totalWidth)
  }

  if (position === 'middle') {
    const leftBudget = Math.ceil(budget / 2)
    const rightBudget = Math.floor(budget / 2)
    return (
      sliceAnsi(text, 0, leftBudget) +
      ellipsis +
      sliceAnsi(text, totalWidth - rightBudget, totalWidth)
    )
  }

  if (options.preferTruncationOnSpace) {
    const sliced = sliceAnsi(text, 0, budget)
    const lastSpace = sliced.lastIndexOf(' ')
    if (lastSpace > 0) {
      return sliced.slice(0, lastSpace) + ellipsis
    }
  }

  return sliceAnsi(text, 0, budget) + ellipsis
}

export function truncateToWidth(text: string, maxWidth: number): string {
  return truncate(text, maxWidth, { position: 'end' })
}

export function truncateMiddle(text: string, maxWidth: number): string {
  return truncate(text, maxWidth, { position: 'middle' })
}

export function truncateStart(text: string, maxWidth: number): string {
  return truncate(text, maxWidth, { position: 'start' })
}
