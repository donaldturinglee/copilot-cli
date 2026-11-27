import React, { useMemo } from 'react'
import { TEARDROP_ASTERISK } from '../constants/figures.js'
import { getSpinnerVerbs } from '../constants/spinner_verbs.js'
import { Box } from '../ink/components/box.js'
import { useAnimationFrame } from '../ink/hooks/use_animation_frame.js'
import type { ThemeColorKey } from './design_system/color.js'
import { ThemedText } from './design_system/themed_text.js'
import {
  SPINNER_FRAME_INTERVAL_MS,
  SPINNER_STALL_THRESHOLD_MS,
  type SpinnerMode,
} from './spinner/types.js'

export type { SpinnerMode } from './spinner/types.js'

const BASE_GLYPHS = ['·', '✢', '✳', '✶', TEARDROP_ASTERISK, '✽']
export const SPINNER_FRAMES = [
  ...BASE_GLYPHS,
  ...[...BASE_GLYPHS].reverse().slice(1, -1),
]

export type SpinnerProps = {
  mode?: SpinnerMode
  message?: string
  /** Timestamp (ms) when current operation started. */
  startTimeMs?: number
  /** Timestamp (ms) of last stream progress event; stalls after 3000ms trigger reddening. */
  lastActivityAtMs?: number
  /** Optional explicit "now" override for deterministic tests. */
  nowMs?: number
  tokenCount?: number
  reducedMotion?: boolean
  overrideColor?: ThemeColorKey
  shimmerColor?: ThemeColorKey
  suffix?: string
}

/**
 * Compute stall reddening intensity in `[0, 1]` once elapsed time since
 * `lastActivityAtMs` exceeds 3000ms.
 */
export function computeStallIntensity(
  nowMs: number,
  lastActivityAtMs: number | undefined,
  mode: SpinnerMode,
): number {
  if (mode === 'stalled') return 1
  if (lastActivityAtMs === undefined) return 0
  const silentMs = nowMs - lastActivityAtMs
  if (silentMs < SPINNER_STALL_THRESHOLD_MS) return 0
  return Math.min(1, (silentMs - SPINNER_STALL_THRESHOLD_MS) / 2000 + 0.5)
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}m ${rem}s`
}

/**
 * 20Hz animated spinner with wave shimmer across verb characters and 3-second
 * stall reddening when streaming pauses.
 */
export function Spinner({
  mode = 'thinking',
  message,
  startTimeMs,
  lastActivityAtMs,
  nowMs,
  tokenCount,
  reducedMotion = false,
  overrideColor,
  shimmerColor = 'claudeShimmer',
  suffix,
}: SpinnerProps): React.ReactNode {
  const liveNow = useAnimationFrame(
    SPINNER_FRAME_INTERVAL_MS,
    nowMs === undefined && !reducedMotion,
  )
  const now = nowMs ?? liveNow

  const verb = useMemo(() => {
    if (message) return message
    const verbs = getSpinnerVerbs()
    return `${verbs[0]}…`
  }, [message])

  const frameIdx = reducedMotion
    ? 0
    : Math.floor(now / SPINNER_FRAME_INTERVAL_MS) % SPINNER_FRAMES.length
  const glyph = SPINNER_FRAMES[frameIdx]!

  const stallIntensity = computeStallIntensity(now, lastActivityAtMs, mode)
  const isStalled = stallIntensity > 0

  const baseColor: ThemeColorKey = isStalled
    ? 'error'
    : overrideColor ??
      (mode === 'thinking'
        ? 'claude'
        : mode === 'tool-use'
          ? 'permission'
          : 'claude')

  const activeShimmer: ThemeColorKey = isStalled ? 'error' : shimmerColor
  const glimmerPos = reducedMotion
    ? -1
    : Math.floor(now / SPINNER_FRAME_INTERVAL_MS) % (verb.length + 6)

  const elapsedPart =
    startTimeMs !== undefined ? formatElapsed(now - startTimeMs) : null
  const tokenPart =
    tokenCount !== undefined && tokenCount > 0 ? `${tokenCount} tokens` : null
  const metaParts = [elapsedPart, tokenPart, suffix].filter(
    (p): p is string => Boolean(p),
  )

  return (
    <Box flexDirection="row" gap={1}>
      <ThemedText color={baseColor} bold>
        {glyph}
      </ThemedText>
      <Box flexDirection="row">
        {reducedMotion ? (
          <ThemedText color={baseColor}>{verb}</ThemedText>
        ) : (
          Array.from(verb).map((ch, idx) => {
            const lit = Math.abs(idx - glimmerPos) <= 1
            return (
              <ThemedText
                key={idx}
                color={lit ? activeShimmer : baseColor}
                bold={lit}
              >
                {ch}
              </ThemedText>
            )
          })
        )}
      </Box>
      {metaParts.length > 0 ? (
        <ThemedText dimColor>({metaParts.join(' · ')})</ThemedText>
      ) : null}
    </Box>
  )
}
