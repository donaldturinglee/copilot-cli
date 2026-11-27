import React, { createContext, useContext, useMemo, useState } from 'react'
import { AlternateScreen } from '../ink/components/alternate_screen.js'
import { Box } from '../ink/components/box.js'
import {
  ScrollBox,
  type ScrollBoxHandle,
} from '../ink/components/scroll_box.js'
import { useTerminalSize } from '../hooks/use_terminal_size.js'
import { ThemedBox } from './design_system/themed_box.js'
import { ThemedText } from './design_system/themed_text.js'

export type StickyPromptHeader = {
  text: string
  scrollTo: () => void
} | null

export type ScrollChromeContextValue = {
  stickyPrompt: StickyPromptHeader
  setStickyPrompt: (sticky: StickyPromptHeader) => void
}

export const ScrollChromeContext = createContext<ScrollChromeContextValue>({
  stickyPrompt: null,
  setStickyPrompt: () => {},
})

export function useScrollChrome(): ScrollChromeContextValue {
  return useContext(ScrollChromeContext)
}

export type FullscreenLayoutProps = {
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
  stickyBottom?: boolean
  /** Top/main scrollable transcript slot. */
  scrollable: React.ReactNode
  /** Pinned bottom input/status chrome, capped at 50% of viewport height. */
  bottom: React.ReactNode
  /** Optional modal overlay rendered in front of bottom/transcript. */
  overlay?: React.ReactNode
  /** Main-screen (inline) fallback when fullscreen alt-screen is disabled. */
  fullscreen?: boolean
}

/**
 * 3-slot REPL layout:
 * 1. Scrollable transcript viewport (with optional sticky prompt header)
 * 2. Pinned bottom composer & status chrome (capped at 50% viewport height)
 * 3. Modal / dialog overlay slot
 */
export function FullscreenLayout({
  scrollRef,
  stickyBottom = true,
  scrollable,
  bottom,
  overlay,
  fullscreen = true,
}: FullscreenLayoutProps): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [stickyPrompt, setStickyPrompt] = useState<StickyPromptHeader>(null)
  const chromeValue = useMemo(
    () => ({ stickyPrompt, setStickyPrompt }),
    [stickyPrompt],
  )

  const maxBottomHeight = Math.max(4, Math.floor(rows * 0.5))

  if (!fullscreen) {
    return (
      <ScrollChromeContext.Provider value={chromeValue}>
        <Box flexDirection="column" width={columns}>
          <Box flexDirection="column">{scrollable}</Box>
          {overlay ? (
            <Box flexDirection="column" marginY={1}>
              {overlay}
            </Box>
          ) : null}
          <Box flexDirection="column">{bottom}</Box>
        </Box>
      </ScrollChromeContext.Provider>
    )
  }

  return (
    <ScrollChromeContext.Provider value={chromeValue}>
      <AlternateScreen>
        {stickyPrompt ? (
          <ThemedBox
            paddingX={1}
            backgroundColor="userMessageBackground"
            overflow="hidden"
          >
            <ThemedText dimColor wrap="truncate-end">
              ❯ {stickyPrompt.text}
            </ThemedText>
          </ThemedBox>
        ) : null}
        <ScrollBox
          ref={scrollRef}
          flexGrow={1}
          width={columns}
          stickyBottom={stickyBottom}
        >
          {scrollable}
        </ScrollBox>
        {overlay ? (
          <Box
            flexDirection="column"
            maxHeight={Math.max(6, Math.floor(rows * 0.75))}
            overflow="hidden"
          >
            {overlay}
          </Box>
        ) : null}
        <Box
          flexDirection="column"
          maxHeight={maxBottomHeight}
          flexShrink={0}
          overflow="hidden"
        >
          {bottom}
        </Box>
      </AlternateScreen>
    </ScrollChromeContext.Provider>
  )
}
