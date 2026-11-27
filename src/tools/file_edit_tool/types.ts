/**
 * Shared types for `FileEditTool` (`Edit`).
 */

import type { StructuredPatchHunk } from '../../utilities/diff.js'

export interface FileEditOutput {
  filePath: string
  oldString: string
  newString: string
  originalFile: string
  structuredPatch: StructuredPatchHunk[]
  userModified: boolean
  replaceAll: boolean
}
