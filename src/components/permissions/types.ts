import type { AnyTool, ToolUseContext } from '../../tool.js'
import type {
  PermissionAskDecision,
  PermissionUpdate,
} from '../../types/permissions.js'

export type PermissionDialogResolution =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      persistToDisk?: boolean
    }
  | {
      behavior: 'deny'
      message?: string
    }

export type InteractivePermissionRequest = {
  id: string
  tool: AnyTool
  toolName: string
  input: Record<string, unknown>
  askDecision: PermissionAskDecision<Record<string, unknown>>
  toolUseId: string
  context: ToolUseContext
  resolve: (resolution: PermissionDialogResolution) => void
}

export type PermissionDialogProps = {
  request: InteractivePermissionRequest
  width?: number
  onResolve: (resolution: PermissionDialogResolution) => void
}
