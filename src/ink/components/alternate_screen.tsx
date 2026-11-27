import React from 'react'
import { Box, type BoxProps } from './box.js'
import { useTerminalSizeContext } from './terminal_size_context.js'

export type AlternateScreenProps = BoxProps & {
  children?: React.ReactNode
}

/**
 * Full-viewport container sized to the terminal dimensions for DEC 1049
 * Alternate Screen mode.
 */
export function AlternateScreen({
  children,
  ...boxProps
}: AlternateScreenProps): React.ReactNode {
  const { columns, rows } = useTerminalSizeContext()
  return (
    <Box
      flexDirection="column"
      width={columns}
      height={rows}
      overflow="hidden"
      {...boxProps}
    >
      {children}
    </Box>
  )
}
