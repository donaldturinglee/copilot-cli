/**
 * Lightweight session state / external metadata notification registry.
 * Allows AppState transitions to notify bridge/SDK listeners without
 * backward imports into Phase 10 bridge modules.
 */

import type {
  ExternalPermissionMode,
  PermissionMode,
} from '../types/permissions.js'
import { enqueueSdkEvent } from './sdk_event_queue.js'

export type SessionExternalMetadata = {
  permission_mode?: ExternalPermissionMode | string
  is_ultraplan_mode?: boolean | null
  [key: string]: unknown
}

export type SessionState = 'idle' | 'running' | 'requires_action'

type MetadataListener = (metadata: SessionExternalMetadata) => void
type PermissionModeListener = (mode: PermissionMode) => void
type SessionStateListener = (state: SessionState) => void

let metadataListener: MetadataListener | null = null
let permissionModeListener: PermissionModeListener | null = null
let sessionStateListener: SessionStateListener | null = null

export function setSessionMetadataChangedListener(
  listener: MetadataListener | null,
): void {
  metadataListener = listener
}

export function setPermissionModeChangedListener(
  listener: PermissionModeListener | null,
): void {
  permissionModeListener = listener
}

export function setSessionStateChangedListener(
  listener: SessionStateListener | null,
): void {
  sessionStateListener = listener
}

export function notifySessionMetadataChanged(
  metadata: SessionExternalMetadata,
): void {
  metadataListener?.(metadata)
}

export function notifyPermissionModeChanged(mode: PermissionMode): void {
  permissionModeListener?.(mode)
}

export function notifySessionStateChanged(state: SessionState): void {
  sessionStateListener?.(state)
  enqueueSdkEvent({
    type: 'system',
    subtype: 'session_state_changed',
    state,
  })
}
