/**
 * Attachment resolution helper for `BriefTool` (`SendUserMessage`).
 */

import { statSync } from 'fs'
import { expandPath } from '../../utilities/path.js'

export interface ResolvedBriefAttachment {
  path: string
  size: number
  isImage: boolean
}

const IMAGE_EXT_REGEX = /\.(?:png|jpe?g|gif|webp)$/i

export function resolveBriefAttachments(
  paths: readonly string[] | undefined,
): ResolvedBriefAttachment[] {
  if (!paths || paths.length === 0) return []
  const resolved: ResolvedBriefAttachment[] = []
  for (const raw of paths) {
    const abs = expandPath(raw)
    const stats = statSync(abs)
    resolved.push({
      path: abs,
      size: stats.size,
      isImage: IMAGE_EXT_REGEX.test(abs),
    })
  }
  return resolved
}
