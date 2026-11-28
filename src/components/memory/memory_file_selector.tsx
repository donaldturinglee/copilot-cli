/**
 * Interactive `/memory` dialog (`MemoryFileSelector`):
 * - Lists layered instruction files (`INSTRUCTIONS.md`, `.copilot/INSTRUCTIONS.md`,
 *   `INSTRUCTIONS.local.md`, `.copilot/rules/*.md`) with `@`-include tree depth
 * - Provides live toggles for Auto-memory (`autoMemoryEnabled`) and Auto-dream
 *   (`autoDreamEnabled`) persisted to user settings
 * - Exposes quick actions to inspect the auto-memory and team-memory directories
 */

import React, { useEffect, useMemo, useState } from 'react'
import { Box } from '../../ink/components/box.js'
import {
  getAutoMemPath,
  isAutoMemoryEnabled,
} from '../../memdir/paths.js'
import {
  getTeamMemPath,
  isTeamMemoryEnabled,
} from '../../memdir/team_mem_paths.js'
import { isAutoDreamEnabled } from '../../services/auto_dream/config.js'
import {
  getMemoryFiles,
  type MemoryFileInfo,
} from '../../utilities/claudemd.js'
import { updateSettingsForSource } from '../../utilities/settings/settings.js'
import type { SelectOptionItem } from '../custom_select/option_map.js'
import { Select } from '../custom_select/select.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'
import { getRelativeMemoryPath } from './memory_update_notification.js'

export interface MemoryFileSelectorProps {
  onSelect: (filePath: string) => void
  onCancel: () => void
  onOpenFolder?: (folderPath: string) => void
  memoryFiles?: readonly MemoryFileInfo[]
}

const ACTION_TOGGLE_AUTO_MEM = '__toggle_auto_memory__'
const ACTION_TOGGLE_AUTO_DREAM = '__toggle_auto_dream__'
const ACTION_OPEN_AUTO_MEM_DIR = '__open_auto_mem_dir__'
const ACTION_OPEN_TEAM_MEM_DIR = '__open_team_mem_dir__'

function buildDepthMap(files: readonly MemoryFileInfo[]): Map<string, number> {
  const byPath = new Map(files.map(f => [f.path, f]))
  const depths = new Map<string, number>()

  const getDepth = (file: MemoryFileInfo, seen = new Set<string>()): number => {
    const cached = depths.get(file.path)
    if (cached !== undefined) return cached
    if (!file.parent || seen.has(file.path)) {
      depths.set(file.path, 0)
      return 0
    }
    seen.add(file.path)
    const parentFile = byPath.get(file.parent)
    const depth = parentFile ? getDepth(parentFile, seen) + 1 : 1
    depths.set(file.path, depth)
    return depth
  }

  for (const file of files) {
    getDepth(file)
  }
  return depths
}

export function MemoryFileSelector({
  onSelect,
  onCancel,
  onOpenFolder,
  memoryFiles: injectedFiles,
}: MemoryFileSelectorProps): React.ReactNode {
  const [autoMemOn, setAutoMemOn] = useState<boolean>(() =>
    isAutoMemoryEnabled(),
  )
  const [autoDreamOn, setAutoDreamOn] = useState<boolean>(() =>
    isAutoDreamEnabled(),
  )
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const [loadedFiles, setLoadedFiles] = useState<readonly MemoryFileInfo[]>(
    () => injectedFiles ?? [],
  )
  useEffect(() => {
    if (injectedFiles !== undefined) {
      setLoadedFiles(injectedFiles)
      return
    }
    let cancelled = false
    void getMemoryFiles()
      .then(res => {
        if (!cancelled) setLoadedFiles(res)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [injectedFiles])

  const files = loadedFiles
  const depths = useMemo(() => buildDepthMap(files), [files])
  const autoMemDir = getAutoMemPath()
  const teamMemEnabled = isTeamMemoryEnabled()
  const teamMemDir = teamMemEnabled ? getTeamMemPath() : null

  const options = useMemo<SelectOptionItem<string>[]>(() => {
    const items: SelectOptionItem<string>[] = []

    for (const file of files) {
      const depth = depths.get(file.path) ?? 0
      const indent = depth > 0 ? `${'  '.repeat(depth)}└─ ` : ''
      const relPath = getRelativeMemoryPath(file.path)
      items.push({
        label: `${indent}${relPath}`,
        value: file.path,
        description: `${file.type}${file.isConditional ? ' (conditional)' : ''}`,
      })
    }

    items.push({
      label: `Auto-memory: ${autoMemOn ? 'ON' : 'OFF'}`,
      value: ACTION_TOGGLE_AUTO_MEM,
      description: 'Toggle persistent project memory (memdir)',
    })

    items.push({
      label: `Auto-dream consolidation: ${autoDreamOn ? 'ON' : 'OFF'}`,
      value: ACTION_TOGGLE_AUTO_DREAM,
      description: 'Toggle background 24h / 5-session memory consolidation',
    })

    items.push({
      label: 'Open auto-memory folder',
      value: ACTION_OPEN_AUTO_MEM_DIR,
      description: getRelativeMemoryPath(autoMemDir),
    })

    if (teamMemDir) {
      items.push({
        label: 'Open team memory folder',
        value: ACTION_OPEN_TEAM_MEM_DIR,
        description: getRelativeMemoryPath(teamMemDir),
      })
    }

    return items
  }, [files, depths, autoMemOn, autoDreamOn, autoMemDir, teamMemDir])

  const handleChange = (value: string): void => {
    if (value === ACTION_TOGGLE_AUTO_MEM) {
      const next = !autoMemOn
      setAutoMemOn(next)
      updateSettingsForSource('userSettings', { autoMemoryEnabled: next })
      setStatusMessage(`Auto-memory ${next ? 'enabled' : 'disabled'}.`)
      return
    }
    if (value === ACTION_TOGGLE_AUTO_DREAM) {
      const next = !autoDreamOn
      setAutoDreamOn(next)
      updateSettingsForSource('userSettings', { autoDreamEnabled: next })
      setStatusMessage(`Auto-dream ${next ? 'enabled' : 'disabled'}.`)
      return
    }
    if (value === ACTION_OPEN_AUTO_MEM_DIR) {
      if (onOpenFolder) {
        onOpenFolder(autoMemDir)
      } else {
        onSelect(autoMemDir)
      }
      return
    }
    if (value === ACTION_OPEN_TEAM_MEM_DIR && teamMemDir) {
      if (onOpenFolder) {
        onOpenFolder(teamMemDir)
      } else {
        onSelect(teamMemDir)
      }
      return
    }
    onSelect(value)
  }

  return (
    <Dialog title="Memory & Instructions" onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        <ThemedText color="secondary">
          Select an instruction file to view/edit, or toggle persistent memory
          settings:
        </ThemedText>
        <Select
          options={options}
          visibleOptionCount={10}
          onChange={handleChange}
          onCancel={onCancel}
        />
        {statusMessage && (
          <ThemedText color="success">{statusMessage}</ThemedText>
        )}
      </Box>
    </Dialog>
  )
}
