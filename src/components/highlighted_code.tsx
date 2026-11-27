import React, { memo, useMemo } from 'react'
import { Box } from '../ink/components/box.js'
import { NoSelect } from '../ink/components/no_select.js'
import { RawAnsi } from '../ink/components/raw_ansi.js'
import { ColorFile } from '../../native/color_diff/index.js'
import { isFullscreenEnvEnabled } from '../utilities/fullscreen.js'
import { sliceAnsi } from '../utilities/slice_ansi.js'
import { useTheme } from './design_system/theme_provider.js'
import { ThemedText } from './design_system/themed_text.js'

export type HighlightedCodeProps = {
  code: string
  filePath?: string
  language?: string
  width?: number
  dim?: boolean
  splitGutter?: boolean
}

function computeFileGutterWidth(code: string): number {
  const lines = code.split('\n')
  const count =
    lines.length > 0 && lines[lines.length - 1] === ''
      ? Math.max(1, lines.length - 1)
      : Math.max(1, lines.length)
  return String(count).length + 2
}

export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  language,
  width = 80,
  dim = false,
  splitGutter,
}: HighlightedCodeProps): React.ReactNode {
  const [themeName] = useTheme()
  const safeWidth = Math.max(4, Math.floor(width))
  const effectivePath =
    filePath ?? (language ? `code.${language}` : 'code.txt')
  const shouldSplit = splitGutter ?? isFullscreenEnvEnabled()

  const rendered = useMemo(() => {
    const lines = new ColorFile(code, effectivePath).render(
      themeName,
      safeWidth,
      dim,
    )
    if (!lines) return null
    const rawGutter = shouldSplit ? computeFileGutterWidth(code) : 0
    const gutterWidth =
      rawGutter > 0 && rawGutter < safeWidth ? rawGutter : 0
    if (gutterWidth > 0) {
      return {
        lines,
        gutterWidth,
        gutters: lines.map(l => sliceAnsi(l, 0, gutterWidth)),
        contents: lines.map(l => sliceAnsi(l, gutterWidth)),
      }
    }
    return { lines, gutterWidth: 0, gutters: null, contents: null }
  }, [code, effectivePath, themeName, safeWidth, dim, shouldSplit])

  if (!rendered) {
    return (
      <Box flexDirection="column">
        <ThemedText dimColor={dim}>{code}</ThemedText>
      </Box>
    )
  }

  if (rendered.gutterWidth > 0 && rendered.gutters && rendered.contents) {
    return (
      <Box flexDirection="row">
        <NoSelect fromLeftEdge={true}>
          <RawAnsi lines={rendered.gutters} width={rendered.gutterWidth} />
        </NoSelect>
        <RawAnsi
          lines={rendered.contents}
          width={Math.max(1, safeWidth - rendered.gutterWidth)}
        />
      </Box>
    )
  }

  return (
    <Box>
      <RawAnsi lines={rendered.lines} width={safeWidth} />
    </Box>
  )
})
