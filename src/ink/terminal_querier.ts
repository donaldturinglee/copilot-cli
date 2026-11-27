import type { Writable } from 'stream'
import { DECRPM_STATUS, type TerminalResponse } from './parse_keypress.js'
import { QUERY_DA1, QUERY_KITTY_KEYBOARD, QUERY_XTVERSION } from './termio/csi.js'
import { DEC_MODE, decQuery } from './termio/dec.js'
import { QUERY_BACKGROUND_COLOR } from './termio/osc.js'

export type TerminalProbeResult = {
  xtversion?: string
  backgroundRgb?: { r: number; g: number; b: number }
  detectedTheme?: 'light' | 'dark'
  supportsSyncOutput?: boolean
  kittyKeyboardFlags?: number
  da1Params?: number[]
  timedOut: boolean
}

type PendingProbe = {
  result: TerminalProbeResult
  resolve: (result: TerminalProbeResult) => void
  timer: ReturnType<typeof setTimeout>
}

const OSC11_RGB_RE = /^rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)$/i

function parseOsc11Rgb(
  data: string,
): { r: number; g: number; b: number } | undefined {
  const m = OSC11_RGB_RE.exec(data.trim())
  if (!m) return undefined
  const scale = (hex: string): number => {
    const val = parseInt(hex, 16)
    const max = (1 << (hex.length * 4)) - 1
    return max > 0 ? Math.round((val / max) * 255) : 0
  }
  return { r: scale(m[1]!), g: scale(m[2]!), b: scale(m[3]!) }
}

/**
 * DA1-fenced terminal capability prober.
 *
 * Sends XTVERSION, OSC 11 background color, DECRQM(2026) synchronized output,
 * and Kitty keyboard queries followed by a universal DA1 (`CSI c`) sentinel.
 * Because terminals answer queries in FIFO order, receiving DA1 immediately
 * resolves the probe without waiting for the timeout — even when the terminal
 * silently ignores unsupported queries.
 */
export class TerminalQuerier {
  private pending: PendingProbe | null = null

  constructor(private readonly writeFn: (seq: string) => void) {}

  static fromStream(stream: Writable): TerminalQuerier {
    return new TerminalQuerier(seq => {
      stream.write(seq)
    })
  }

  /**
   * Issue a DA1-fenced probe batch and await completion (or timeout).
   */
  probe(options?: {
    timeoutMs?: number
    queryXtversion?: boolean
    queryBackground?: boolean
    querySyncOutput?: boolean
    queryKittyKeyboard?: boolean
  }): Promise<TerminalProbeResult> {
    this.cancel()

    const timeoutMs = options?.timeoutMs ?? 200
    const batch: string[] = []
    if (options?.queryXtversion !== false) batch.push(QUERY_XTVERSION)
    if (options?.queryBackground !== false) batch.push(QUERY_BACKGROUND_COLOR)
    if (options?.querySyncOutput !== false) {
      batch.push(decQuery(DEC_MODE.SYNCHRONIZED_OUTPUT))
    }
    if (options?.queryKittyKeyboard !== false) batch.push(QUERY_KITTY_KEYBOARD)
    // DA1 sentinel closes the fence
    batch.push(QUERY_DA1)

    return new Promise<TerminalProbeResult>(resolve => {
      const result: TerminalProbeResult = { timedOut: false }
      const timer = setTimeout(() => {
        if (!this.pending) return
        const current = this.pending
        this.pending = null
        current.result.timedOut = true
        current.resolve(current.result)
      }, timeoutMs)

      this.pending = { result, resolve, timer }
      this.writeFn(batch.join(''))
    })
  }

  /**
   * Feed an inbound `TerminalResponse` parsed from stdin into the active probe.
   * Returns `true` if a probe consumed the response.
   */
  handleResponse(response: TerminalResponse): boolean {
    if (!this.pending) return false
    const { result } = this.pending

    switch (response.type) {
      case 'xtversion':
        result.xtversion = response.name
        return true

      case 'osc':
        if (response.code === 11) {
          const rgb = parseOsc11Rgb(response.data)
          if (rgb) {
            result.backgroundRgb = rgb
            const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b
            result.detectedTheme = luminance > 128 ? 'light' : 'dark'
          }
        }
        return true

      case 'decrpm':
        if (response.mode === DEC_MODE.SYNCHRONIZED_OUTPUT) {
          result.supportsSyncOutput =
            response.status === DECRPM_STATUS.SET ||
            response.status === DECRPM_STATUS.RESET ||
            response.status === DECRPM_STATUS.PERMANENTLY_SET
        }
        return true

      case 'kittyKeyboard':
        result.kittyKeyboardFlags = response.flags
        return true

      case 'da1': {
        result.da1Params = response.params
        const current = this.pending
        this.pending = null
        clearTimeout(current.timer)
        current.resolve(current.result)
        return true
      }

      default:
        return false
    }
  }

  cancel(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending = null
  }
}
