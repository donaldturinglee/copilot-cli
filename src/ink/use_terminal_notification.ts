import { useCallback } from 'react'
import { BEL } from './termio/ansi.js'
import { notifyOsc9 } from './termio/osc.js'

export type TerminalNotificationOptions = {
  title?: string
  body: string
  bell?: boolean
}

export function sendTerminalNotification(
  options: TerminalNotificationOptions,
  writeFn: (seq: string) => void = seq => {
    if (process.stdout.isTTY) process.stdout.write(seq)
  },
): void {
  const text = options.title ? `${options.title}: ${options.body}` : options.body
  writeFn(notifyOsc9(text))
  if (options.bell) {
    writeFn(BEL)
  }
}

export function useTerminalNotification(): (
  options: TerminalNotificationOptions,
) => void {
  return useCallback((options: TerminalNotificationOptions) => {
    sendTerminalNotification(options)
  }, [])
}
