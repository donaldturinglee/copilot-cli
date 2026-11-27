import { writeFileSync } from 'fs'
import { resolve } from 'path'
import React, { useState } from 'react'
import { Box } from '../ink/components/box.js'
import type { Message } from '../types/message.js'
import { getCwd } from '../utilities/cwd.js'
import { renderTranscriptMarkdown } from '../utilities/export_renderer.js'
import { Dialog } from './design_system/dialog.js'
import { ThemedText } from './design_system/themed_text.js'
import { TextInput } from './text_input.js'

export type ExportDialogProps = {
  messages: readonly Message[]
  defaultFilename?: string
  onDone: (summary: string) => void
  onCancel: () => void
}

export function ExportDialog({
  messages,
  defaultFilename = 'copilot-transcript.md',
  onDone,
  onCancel,
}: ExportDialogProps): React.ReactNode {
  const [filename, setFilename] = useState(defaultFilename)
  const [error, setError] = useState<string | null>(null)

  const handleExport = (target: string) => {
    const clean = target.trim() || defaultFilename
    const outPath = resolve(getCwd(), clean)
    try {
      const md = renderTranscriptMarkdown(messages)
      writeFileSync(outPath, md, 'utf8')
      onDone(`Exported conversation (${messages.length} messages) to ${outPath}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog
      title="Export Conversation (/export)"
      subtitle="Enter file path to write Markdown transcript · Esc to cancel"
      width={72}
      overlayId="export-dialog"
      onCancel={onCancel}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <ThemedText bold>File:</ThemedText>
          <TextInput
            value={filename}
            onChange={setFilename}
            onSubmit={handleExport}
          />
        </Box>
        {error ? <ThemedText color="error">{error}</ThemedText> : null}
      </Box>
    </Dialog>
  )
}
