import type { StructuredPatchHunk } from 'diff'
import React, { memo, useMemo } from 'react'
import { useSettings } from '../hooks/use_settings.js'
import { Box } from '../ink/components/box.js'
import { NoSelect } from '../ink/components/no_select.js'
import { RawAnsi } from '../ink/components/raw_ansi.js'
import { ColorDiff } from '../../native/color_diff/index.js'
import { isFullscreenEnvEnabled } from '../utilities/fullscreen.js'
import { sliceAnsi } from '../utilities/slice_ansi.js'
import { useTheme } from './design_system/theme_provider.js'
import { ThemedText } from './design_system/themed_text.js'

export type StructuredDiffProps = {
  patch: StructuredPatchHunk
  dim?: boolean
  filePath: string
  firstLine: string | null
  fileContent?: string
  width: number
  skipHighlighting?: boolean
  /** Override fullscreen split-gutter behavior explicitly (useful for tests/demos). */
  splitGutter?: boolean
}

type CachedRender = {
  lines: string[]
  gutterWidth: number
  gutters: string[] | null
  contents: string[] | null
}

// Module-level WeakMap cache so remounts (e.g. transcript toggle) are O(1) lookups
const RENDER_CACHE = new WeakMap<
  StructuredPatchHunk,
  Map<string, CachedRender>
>()

function computeGutterWidth(patch: StructuredPatchHunk): number {
  const maxLineNumber = Math.max(
    patch.oldStart + patch.oldLines - 1,
    patch.newStart + patch.newLines - 1,
    1,
  )
  return String(maxLineNumber).length + 3
}

function renderColorDiffCached(
  patch: StructuredPatchHunk,
  firstLine: string | null,
  filePath: string,
  fileContent: string | null,
  theme: string,
  width: number,
  dim: boolean,
  splitGutter: boolean,
): CachedRender | null {
  const rawGutterWidth = splitGutter ? computeGutterWidth(patch) : 0
  const gutterWidth =
    rawGutterWidth > 0 && rawGutterWidth < width ? rawGutterWidth : 0
  const key = `${theme}|${width}|${dim ? 1 : 0}|${gutterWidth}|${firstLine ?? ''}|${filePath}`

  let perHunk = RENDER_CACHE.get(patch)
  const hit = perHunk?.get(key)
  if (hit) return hit

  const lines = new ColorDiff(patch, firstLine, filePath, fileContent).render(
    theme,
    width,
    dim,
  )
  if (!lines) return null

  let gutters: string[] | null = null
  let contents: string[] | null = null
  if (gutterWidth > 0) {
    gutters = lines.map(l => sliceAnsi(l, 0, gutterWidth))
    contents = lines.map(l => sliceAnsi(l, gutterWidth))
  }

  const entry: CachedRender = { lines, gutterWidth, gutters, contents }
  if (!perHunk) {
    perHunk = new Map()
    RENDER_CACHE.set(patch, perHunk)
  }
  if (perHunk.size >= 4) perHunk.clear()
  perHunk.set(key, entry)
  return entry
}

function StructuredDiffFallback({
  patch,
  dim,
}: {
  patch: StructuredPatchHunk
  dim: boolean
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      {patch.lines.map((line, idx) => {
        const marker = line[0]
        const color =
          marker === '+' ? 'success' : marker === '-' ? 'error' : 'text'
        return (
          <ThemedText key={idx} color={color} dimColor={dim}>
            {line}
          </ThemedText>
        )
      })}
    </Box>
  )
}

export const StructuredDiff = memo(function StructuredDiff({
  patch,
  dim = false,
  filePath,
  firstLine,
  fileContent,
  width,
  skipHighlighting = false,
  splitGutter,
}: StructuredDiffProps): React.ReactNode {
  const [theme] = useTheme()
  const settings = useSettings()
  const syntaxDisabled =
    (settings as { syntaxHighlightingDisabled?: boolean })
      .syntaxHighlightingDisabled ?? false
  const safeWidth = Math.max(1, Math.floor(width))
  const shouldSplit = splitGutter ?? isFullscreenEnvEnabled()

  const cached = useMemo(() => {
    if (skipHighlighting || syntaxDisabled) return null
    return renderColorDiffCached(
      patch,
      firstLine,
      filePath,
      fileContent ?? null,
      theme,
      safeWidth,
      dim,
      shouldSplit,
    )
  }, [
    patch,
    firstLine,
    filePath,
    fileContent,
    theme,
    safeWidth,
    dim,
    shouldSplit,
    skipHighlighting,
    syntaxDisabled,
  ])

  if (!cached) {
    return (
      <Box>
        <StructuredDiffFallback patch={patch} dim={dim} />
      </Box>
    )
  }

  const { lines, gutterWidth, gutters, contents } = cached

  // Dual-column O(1)-leaf layout: <NoSelect> gutter + selectable content column
  if (gutterWidth > 0 && gutters && contents) {
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge={true}>
          <RawAnsi lines={gutters} width={gutterWidth} />
        </NoSelect>
        <RawAnsi
          lines={contents}
          width={Math.max(1, safeWidth - gutterWidth)}
        />
      </Box>
    )
  }

  return (
    <Box>
      <RawAnsi lines={lines} width={safeWidth} />
    </Box>
  )
})
