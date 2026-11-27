/**
 * Output truncation, middle-elision, and inline data-URI image extraction
 * helpers for shell tools.
 */

import { getMaxOutputLength } from '../../utilities/shell/output_limits.js'

export interface TruncatedShellOutput {
  content: string
  truncated: boolean
  totalLines: number
}

/**
 * Truncates long shell output while preserving both the beginning and end of
 * the stream (middle-truncation) within `maxChars`.
 */
export function truncateShellOutput(
  text: string,
  maxChars: number = getMaxOutputLength(),
): TruncatedShellOutput {
  const totalLines = text ? text.split('\n').length : 0
  if (text.length <= maxChars) {
    return { content: text, truncated: false, totalLines }
  }
  const half = Math.floor(maxChars / 2)
  const head = text.slice(0, half)
  const tail = text.slice(text.length - half)
  const omitted = text.length - head.length - tail.length
  return {
    content: `${head}\n... [${omitted} characters truncated] ...\n${tail}`,
    truncated: true,
    totalLines,
  }
}

/**
 * Detects an exact inline base64 data URI (`data:image/png;base64,...`) printed
 * by a command so callers can forward it cleanly as an image block.
 */
export function extractImageDataUri(
  output: string,
): { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; base64: string } | null {
  const trimmed = output.trim()
  const match = trimmed.match(
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/,
  )
  if (!match?.[1] || !match[2]) {
    return null
  }
  return {
    mediaType: match[1] as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
    base64: match[2].replace(/\s+/g, ''),
  }
}
