import React from 'react'
import { Box, type BoxProps } from './box.js'

export type NoSelectProps = BoxProps & {
  /** Mark all columns from x=0 to the right edge of this box as non-selectable. */
  fromLeftEdge?: boolean
}

/**
 * Marks a rendered subtree as excluded from terminal drag-selection copying
 * (e.g., diff line-number gutters, sidebar chrome, decorative borders).
 */
export function NoSelect({
  fromLeftEdge = false,
  children,
  ...boxProps
}: NoSelectProps): React.ReactNode {
  return (
    <Box
      {...boxProps}
      noSelect={true}
      noSelectFromLeftEdge={fromLeftEdge}
    >
      {children}
    </Box>
  )
}
