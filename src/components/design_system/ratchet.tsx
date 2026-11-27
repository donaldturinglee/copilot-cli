import React, { useLayoutEffect, useRef, useState } from 'react'
import { Box, type BoxProps } from '../../ink/components/box.js'
import type { DOMElement } from '../../ink/dom.js'
import { measureElement } from '../../ink/measure_element.js'

export type RatchetProps = BoxProps & {
  /** Keep minimum height monotonically non-decreasing to prevent vertical flicker. */
  lock?: 'height' | 'none'
}

export function Ratchet({
  lock = 'height',
  children,
  ...boxProps
}: RatchetProps): React.ReactNode {
  const ref = useRef<DOMElement | null>(null)
  const [minHeight, setMinHeight] = useState(0)

  useLayoutEffect(() => {
    if (lock === 'none' || !ref.current) return
    const { height } = measureElement(ref.current)
    if (height > minHeight) {
      setMinHeight(height)
    }
  })

  return (
    <Box
      ref={ref}
      flexDirection="column"
      minHeight={lock === 'height' ? minHeight : undefined}
      {...boxProps}
    >
      {children}
    </Box>
  )
}
