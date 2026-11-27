import type { StructuredPatchHunk } from 'diff'
import React from 'react'
import { Box } from '../ink/components/box.js'
import { ThemedText } from './design_system/themed_text.js'
import { StructuredDiff } from './structured_diff.js'

export type StructuredDiffListProps = {
  hunks: readonly StructuredPatchHunk[]
  filePath: string
  firstLine?: string | null
  fileContent?: string
  width: number
  dim?: boolean
  skipHighlighting?: boolean
  splitGutter?: boolean
}

export function StructuredDiffList({
  hunks,
  filePath,
  firstLine = null,
  fileContent,
  width,
  dim = false,
  skipHighlighting = false,
  splitGutter,
}: StructuredDiffListProps): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      {hunks.map((hunk, idx) => (
        <Box key={idx} flexDirection="column">
          {idx > 0 ? <ThemedText dimColor>···</ThemedText> : null}
          <StructuredDiff
            patch={hunk}
            dim={dim}
            filePath={filePath}
            firstLine={firstLine}
            fileContent={fileContent}
            width={width}
            skipHighlighting={skipHighlighting}
            splitGutter={splitGutter}
          />
        </Box>
      ))}
    </Box>
  )
}
