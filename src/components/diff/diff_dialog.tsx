import { execSync } from 'child_process'
import React, { useMemo, useState } from 'react'
import { Box } from '../../ink/components/box.js'
import { useKeybindings } from '../../keybindings/use_keybinding.js'
import { getCwd } from '../../utilities/cwd.js'
import { Dialog } from '../design_system/dialog.js'
import { ThemedText } from '../design_system/themed_text.js'

export type DiffFileEntry = {
  filePath: string
  diffLines: string[]
}

export type DiffDialogProps = {
  files?: readonly DiffFileEntry[]
  cwd?: string
  onClose: () => void
}

function loadGitDiffFiles(cwd: string): DiffFileEntry[] {
  try {
    const raw = execSync('git diff --no-color', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!raw.trim()) return []
    const chunks = raw.split(/^diff --git /m).filter(Boolean)
    return chunks.map(chunk => {
      const lines = chunk.split('\n')
      const header = lines[0] ?? 'unknown'
      const match = /b\/(.+)$/.exec(header)
      return {
        filePath: match?.[1] ?? header,
        diffLines: lines.slice(1, 25),
      }
    })
  } catch {
    return []
  }
}

export function DiffDialog({
  files,
  cwd,
  onClose,
}: DiffDialogProps): React.ReactNode {
  const entries = useMemo(
    () => files ?? loadGitDiffFiles(cwd ?? getCwd()),
    [files, cwd],
  )
  const [selectedIdx, setSelectedIdx] = useState(0)

  useKeybindings(
    {
      'diff:previousFile': () =>
        setSelectedIdx(i => Math.max(0, i - 1)),
      'diff:nextFile': () =>
        setSelectedIdx(i => Math.min(Math.max(0, entries.length - 1), i + 1)),
      'diff:close': onClose,
    },
    { context: 'DiffDialog' },
  )

  const current = entries[selectedIdx]

  return (
    <Dialog
      title="Git Diff Viewer (/diff)"
      subtitle="Up/Down switch files · Esc to close"
      width={78}
      overlayId="diff-dialog"
      onCancel={onClose}
    >
      {entries.length === 0 ? (
        <ThemedText dimColor>No unstaged working tree changes.</ThemedText>
      ) : (
        <Box flexDirection="column" gap={1}>
          <ThemedText bold color="claude">
            File {selectedIdx + 1}/{entries.length}: {current?.filePath}
          </ThemedText>
          <Box flexDirection="column">
            {current?.diffLines.map((line, idx) => {
              const color = line.startsWith('+')
                ? 'success'
                : line.startsWith('-')
                  ? 'error'
                  : line.startsWith('@@')
                    ? 'suggestion'
                    : 'text'
              return (
                <ThemedText key={idx} color={color} wrap="truncate-end">
                  {line}
                </ThemedText>
              )
            })}
          </Box>
        </Box>
      )}
    </Dialog>
  )
}
