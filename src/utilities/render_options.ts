import type { Readable, Writable } from 'stream'
import { isFullscreenEnvEnabled } from './fullscreen.js'

export type InkRenderOptions = {
  stdout?: Writable & { columns?: number; rows?: number; isTTY?: boolean }
  stdin?: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  stderr?: Writable & { columns?: number; rows?: number; isTTY?: boolean }
  debug?: boolean
  exitOnCtrlC?: boolean
  patchConsole?: boolean
  altScreen?: boolean
  maxFps?: number
  kittyKeyboard?: boolean
  mouse?: boolean
  bracketedPaste?: boolean
  onFlicker?: (desiredHeight: number, actualHeight: number, reason: string) => void
}

export function getDefaultRenderOptions(
  overrides: Partial<InkRenderOptions> = {},
): Required<
  Pick<
    InkRenderOptions,
    | 'debug'
    | 'exitOnCtrlC'
    | 'patchConsole'
    | 'altScreen'
    | 'maxFps'
    | 'kittyKeyboard'
    | 'mouse'
    | 'bracketedPaste'
  >
> &
  InkRenderOptions {
  const altScreen = overrides.altScreen ?? isFullscreenEnvEnabled()
  return {
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    debug: false,
    exitOnCtrlC: true,
    patchConsole: true,
    altScreen,
    maxFps: 60,
    kittyKeyboard: true,
    mouse: altScreen,
    bracketedPaste: true,
    ...overrides,
  }
}
