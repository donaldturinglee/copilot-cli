import React from 'react'
import { AskUserQuestionDialog } from './ask_user_question_dialog.js'
import { BashPermissionDialog } from './bash_permission_dialog.js'
import { FallbackPermissionDialog } from './fallback_permission_dialog.js'
import { FileEditPermissionDialog } from './file_edit_permission_dialog.js'
import { FileWritePermissionDialog } from './file_write_permission_dialog.js'
import { FilesystemPermissionDialog } from './filesystem_permission_dialog.js'
import { NotebookEditPermissionDialog } from './notebook_edit_permission_dialog.js'
import { PlanPermissionDialog } from './plan_permission_dialog.js'
import { PowerShellPermissionDialog } from './powershell_permission_dialog.js'
import type { PermissionDialogProps } from './types.js'
import { WebFetchPermissionDialog } from './webfetch_permission_dialog.js'

/**
 * Dispatcher rendering the tool-specific interactive permission approval dialog
 * directly inside the REPL overlay/bottom slot.
 */
export function PermissionRequest(props: PermissionDialogProps): React.ReactNode {
  const { toolName } = props.request
  switch (toolName) {
    case 'Bash':
      return <BashPermissionDialog {...props} />
    case 'PowerShell':
      return <PowerShellPermissionDialog {...props} />
    case 'Edit':
    case 'FileEdit':
      return <FileEditPermissionDialog {...props} />
    case 'Write':
    case 'FileWrite':
      return <FileWritePermissionDialog {...props} />
    case 'NotebookEdit':
      return <NotebookEditPermissionDialog {...props} />
    case 'WebFetch':
      return <WebFetchPermissionDialog {...props} />
    case 'Read':
    case 'FileRead':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return <FilesystemPermissionDialog {...props} />
    case 'ExitPlanMode':
      return <PlanPermissionDialog {...props} />
    case 'AskUserQuestion':
      return <AskUserQuestionDialog {...props} />
    default:
      return <FallbackPermissionDialog {...props} />
  }
}
