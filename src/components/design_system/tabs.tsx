import React, { useState } from 'react'
import { Box } from '../../ink/components/box.js'
import { useKeybindings } from '../../keybindings/use_keybinding.js'
import { ThemedText } from './themed_text.js'

export type TabProps = {
  id: string
  title: string
  children: React.ReactNode
}

export function Tab({ children }: TabProps): React.ReactNode {
  return <Box flexDirection="column">{children}</Box>
}

export type TabsProps = {
  defaultTabId?: string
  activeTabId?: string
  onTabChange?: (tabId: string) => void
  isActive?: boolean
  children: React.ReactNode
}

export function Tabs({
  defaultTabId,
  activeTabId,
  onTabChange,
  isActive = true,
  children,
}: TabsProps): React.ReactNode {
  const tabs = React.Children.toArray(children).filter(
    (child): child is React.ReactElement<TabProps> =>
      React.isValidElement<TabProps>(child),
  )

  const [internalId, setInternalId] = useState<string>(
    () => defaultTabId ?? tabs[0]?.props.id ?? '',
  )
  const currentId = activeTabId ?? internalId
  const currentIdx = Math.max(
    0,
    tabs.findIndex(t => t.props.id === currentId),
  )

  const selectIndex = (idx: number): void => {
    if (tabs.length === 0) return
    const wrapped = (idx + tabs.length) % tabs.length
    const nextTab = tabs[wrapped]
    if (!nextTab) return
    setInternalId(nextTab.props.id)
    onTabChange?.(nextTab.props.id)
  }

  useKeybindings(
    {
      'tabs:next': () => selectIndex(currentIdx + 1),
      'tabs:previous': () => selectIndex(currentIdx - 1),
    },
    { context: 'Tabs', isActive },
  )

  const activeTab = tabs[currentIdx]

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2}>
        {tabs.map((tab, idx) => {
          const selected = idx === currentIdx
          return (
            <ThemedText
              key={tab.props.id}
              bold={selected}
              underline={selected}
              color={selected ? 'suggestion' : 'inactive'}
            >
              {tab.props.title}
            </ThemedText>
          )
        })}
      </Box>
      {activeTab ?? null}
    </Box>
  )
}
