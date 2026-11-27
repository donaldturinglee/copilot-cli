import { structuredPatch } from 'diff'
import React, { memo, useMemo } from 'react'
import { Box } from '../ink/components/box.js'
import { StructuredDiff } from './structured_diff.js'

export type FileEditToolDiffProps = {
  filePath: string
  oldString: string
  newString: string
  width?: number
  dim?: boolean
}

export const FileEditToolDiff = memo(function FileEditToolDiff({
  filePath,
  oldString,
  newString,
  width = 76,
  dim = false,
}: FileEditToolDiffProps): React.ReactNode {
  const hunks = useMemo(() => {
    const patch = structuredPatch(
      filePath,
      filePath,
      oldString,
      newString,
      '',
      '',
      { context: 3 },
    )
    return patch.hunks
  }, [filePath, oldString, newString])

  if (hunks.length === 0) return null

  const firstLine = (oldString.split('\n')[0] ?? newString.split('\n')[0]) || null

  return (
    <Box flexDirection="column" gap={0}>
      {hunks.map((hunk, idx) => (
        <StructuredDiff
          key={idx}
          patch={hunk}
          filePath={filePath}
          firstLine={firstLine}
          width={Math.max(20, width - 6)}
          dim={dim}
        />
      ))}
    </Box>
  )
})
