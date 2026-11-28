/**
 * Compact inline notification banner displayed when a persistent memory file
 * is updated (`MemoryUpdateNotification`).
 */

import { homedir } from 'os'
import { isAbsolute, relative } from 'path'
import React from 'react'
import { Box } from '../../ink/components/box.js'
import { getCwd } from '../../utilities/cwd.js'
import { ThemedText } from '../design_system/themed_text.js'

/**
 * Formats a memory file path concisely relative to `cwd` or `~/` when under
 * the user's home directory.
 */
export function getRelativeMemoryPath(
  memoryPath: string,
  cwd: string = getCwd(),
): string {
  const relToCwd = relative(cwd, memoryPath)
  if (relToCwd && !relToCwd.startsWith('..') && !isAbsolute(relToCwd)) {
    return relToCwd.replace(/\\/g, '/')
  }
  const home = homedir()
  const relToHome = relative(home, memoryPath)
  if (relToHome && !relToHome.startsWith('..') && !isAbsolute(relToHome)) {
    return `~/${relToHome.replace(/\\/g, '/')}`
  }
  return memoryPath
}

export interface MemoryUpdateNotificationProps {
  memoryPath: string
  verb?: string
}

export function MemoryUpdateNotification({
  memoryPath,
  verb = 'Updated',
}: MemoryUpdateNotificationProps): React.ReactNode {
  const displayPath = getRelativeMemoryPath(memoryPath)
  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color="success">●</ThemedText>
      <ThemedText color="secondary">
        {verb} memory ({displayPath}) — manage with /memory
      </ThemedText>
    </Box>
  )
}
