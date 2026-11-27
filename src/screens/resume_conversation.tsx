import React from 'react'
import { Dialog } from '../components/design_system/dialog.js'
import { LogSelector } from '../components/log_selector.js'
import type { LogOption } from '../types/logs.js'

export type ResumeConversationProps = {
  logs: readonly LogOption[]
  onSelect: (log: LogOption) => void
  onCancel: () => void
}

export function ResumeConversation({
  logs,
  onSelect,
  onCancel,
}: ResumeConversationProps): React.ReactNode {
  return (
    <Dialog
      title="Resume Conversation (/resume)"
      subtitle="Select a previous session · Esc to cancel"
      width={76}
      overlayId="resume-screen"
      onCancel={onCancel}
    >
      <LogSelector logs={logs} onSelect={onSelect} onCancel={onCancel} />
    </Dialog>
  )
}
