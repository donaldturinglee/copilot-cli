import { execFile } from 'child_process'
import React, { useEffect, useRef, useState } from 'react'
import { Box } from '../ink/components/box.js'
import { getTotalCost } from '../cost_tracker.js'
import type { PermissionMode } from '../types/permissions.js'
import { Byline } from './design_system/byline.js'
import { ThemedText } from './design_system/themed_text.js'
import { EffortIndicator } from './effort_indicator.js'
import { FastIcon } from './fast_icon.js'
import type { EffortValue } from '../types/forward.js'

export const STATUSLINE_DEBOUNCE_MS = 300

export type StatusLinePayload = {
  cwd: string
  model: string
  permissionMode: PermissionMode
  costUsd: number
  contextPercent?: number
}

export type StatusLineProps = {
  cwd: string
  model: string
  permissionMode: PermissionMode
  effort?: EffortValue
  fastMode?: boolean
  vimMode?: 'INSERT' | 'NORMAL' | null
  contextPercent?: number
  statusLineCommand?: string
  overrideText?: string
  queuedCount?: number
  /** Injectable command runner for tests. */
  commandRunner?: (
    command: string,
    payload: StatusLinePayload,
  ) => Promise<string>
}

function defaultRunStatusCommand(
  command: string,
  payload: StatusLinePayload,
): Promise<string> {
  return new Promise(resolve => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const args =
      process.platform === 'win32' ? ['/c', command] : ['-c', command]
    const child = execFile(
      shell,
      args,
      {
        cwd: payload.cwd,
        timeout: 1500,
        maxBuffer: 16 * 1024,
      },
      (err, stdout) => {
        if (err) {
          resolve('')
          return
        }
        resolve(stdout.trim().split('\n')[0] ?? '')
      },
    )
    if (child.stdin) {
      child.stdin.end(JSON.stringify(payload))
    }
  })
}

/**
 * Bottom status bar supporting 300ms debounced external statusline commands
 * and built-in model/mode/Vim/cost/queue indicators.
 */
export function StatusLine({
  cwd,
  model,
  permissionMode,
  effort,
  fastMode = false,
  vimMode = null,
  contextPercent,
  statusLineCommand,
  overrideText,
  queuedCount = 0,
  commandRunner = defaultRunStatusCommand,
}: StatusLineProps): React.ReactNode {
  const [externalText, setExternalText] = useState<string>('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const costUsd = getTotalCost()

  useEffect(() => {
    if (!statusLineCommand) {
      setExternalText('')
      return
    }
    if (timerRef.current) clearTimeout(timerRef.current)
    let cancelled = false
    timerRef.current = setTimeout(() => {
      void commandRunner(statusLineCommand, {
        cwd,
        model,
        permissionMode,
        costUsd,
        contextPercent,
      }).then(text => {
        if (!cancelled) setExternalText(text)
      })
    }, STATUSLINE_DEBOUNCE_MS)
    if (typeof timerRef.current.unref === 'function') {
      timerRef.current.unref()
    }
    return () => {
      cancelled = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [
    statusLineCommand,
    cwd,
    model,
    permissionMode,
    costUsd,
    contextPercent,
    commandRunner,
  ])

  const customLine = overrideText || externalText
  const modeColor =
    permissionMode === 'bypassPermissions'
      ? 'error'
      : permissionMode === 'plan'
        ? 'planMode'
        : permissionMode === 'acceptEdits'
          ? 'autoAccept'
          : 'inactive'

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
      <Byline>
        {vimMode ? (
          <ThemedText
            bold
            color={vimMode === 'NORMAL' ? 'warning' : 'success'}
          >
            -- {vimMode} --
          </ThemedText>
        ) : null}
        <ThemedText color={modeColor}>{permissionMode}</ThemedText>
        <ThemedText dimColor>{model}</ThemedText>
        {effort ? <EffortIndicator effort={effort} /> : null}
        {fastMode ? <FastIcon active /> : null}
        {queuedCount > 0 ? (
          <ThemedText color="warning">{queuedCount} queued</ThemedText>
        ) : null}
        {customLine ? <ThemedText dimColor>{customLine}</ThemedText> : null}
      </Byline>
      <Byline>
        {contextPercent !== undefined ? (
          <ThemedText
            color={contextPercent >= 85 ? 'warning' : 'inactive'}
            dimColor={contextPercent < 85}
          >
            ctx {Math.round(contextPercent)}%
          </ThemedText>
        ) : null}
        {costUsd > 0 ? (
          <ThemedText dimColor>${costUsd.toFixed(4)}</ThemedText>
        ) : null}
      </Byline>
    </Box>
  )
}
