/**
 * Telemetry helper for recording file read/edit/write analytics without leaking
 * file contents or PII.
 */

import { extname } from 'path'
import {
  logEvent,
  type VerifiedNonSensitiveAnalyticsMetadata,
} from '../services/analytics/index.js'

export type FileOperationKind = 'read' | 'edit' | 'write' | 'notebook_edit'

export interface LogFileOperationParams {
  operation: FileOperationKind
  tool: string
  filePath: string
  content?: string
  linesAdded?: number
  linesRemoved?: number
  success?: boolean
}

export function logFileOperation(params: LogFileOperationParams): void {
  const ext = extname(params.filePath).toLowerCase() || 'none'
  logEvent('tengu_file_operation', {
    operation: params.operation as VerifiedNonSensitiveAnalyticsMetadata,
    tool: params.tool as VerifiedNonSensitiveAnalyticsMetadata,
    extension: ext as VerifiedNonSensitiveAnalyticsMetadata,
    ...(params.content !== undefined ? { byteLength: params.content.length } : {}),
    ...(params.linesAdded !== undefined ? { linesAdded: params.linesAdded } : {}),
    ...(params.linesRemoved !== undefined
      ? { linesRemoved: params.linesRemoved }
      : {}),
    ...(params.success !== undefined ? { success: params.success } : {}),
  })
}
