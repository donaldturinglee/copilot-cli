import React from 'react'
import {
  DIAMOND_FILLED,
  DIAMOND_OPEN,
  FIGURES,
} from '../../constants/figures.js'
import type { ThemeColorKey } from './color.js'
import { ThemedText } from './themed_text.js'

export type StatusKind =
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'pending'
  | 'running'

export type StatusIconProps = {
  status: StatusKind
}

const STATUS_MAP: Record<StatusKind, { icon: string; color: ThemeColorKey }> = {
  success: { icon: FIGURES.tick, color: 'success' },
  error: { icon: FIGURES.cross, color: 'error' },
  warning: { icon: FIGURES.warning, color: 'warning' },
  info: { icon: FIGURES.info, color: 'suggestion' },
  pending: { icon: DIAMOND_OPEN, color: 'inactive' },
  running: { icon: DIAMOND_FILLED, color: 'claude' },
}

export function StatusIcon({ status }: StatusIconProps): React.ReactNode {
  const spec = STATUS_MAP[status]
  return <ThemedText color={spec.color}>{spec.icon}</ThemedText>
}
