import React from 'react'
import { useMemoryUsage } from '../hooks/use_memory_usage.js'
import { ThemedText } from './design_system/themed_text.js'

export function MemoryUsageIndicator(): React.ReactNode {
  const { rssMb, heapUsedMb } = useMemoryUsage()
  return (
    <ThemedText dimColor>
      mem: {heapUsedMb}MB heap / {rssMb}MB rss
    </ThemedText>
  )
}
