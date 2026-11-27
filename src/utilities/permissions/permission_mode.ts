/**
 * Permission mode metadata, titles, and external/internal mode conversions.
 */

import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
} from '../../types/permissions.js'

const EXTERNAL_MODE_SET = new Set<string>(EXTERNAL_PERMISSION_MODES)

export function isExternalPermissionMode(
  mode: string,
): mode is ExternalPermissionMode {
  return EXTERNAL_MODE_SET.has(mode)
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  if (isExternalPermissionMode(mode)) {
    return mode
  }
  return 'default'
}

export function isPlanMode(mode: PermissionMode): boolean {
  return mode === 'plan'
}

export function isAutoMode(mode: PermissionMode): boolean {
  return mode === 'auto'
}

export function permissionModeTitle(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'Default'
    case 'acceptEdits':
      return 'Accept Edits'
    case 'plan':
      return 'Plan Mode'
    case 'dontAsk':
      return "Don't Ask"
    case 'bypassPermissions':
      return 'Bypass Permissions'
    case 'auto':
      return 'Auto Mode'
    case 'bubble':
      return 'Bubble'
  }
}

export function permissionModeShortTitle(mode: PermissionMode): string {
  switch (mode) {
    case 'default':
      return 'default'
    case 'acceptEdits':
      return 'accept edits'
    case 'plan':
      return 'plan'
    case 'dontAsk':
      return 'dont ask'
    case 'bypassPermissions':
      return 'bypass'
    case 'auto':
      return 'auto'
    case 'bubble':
      return 'bubble'
  }
}
