import React, { useMemo, useState } from 'react'
import { FIGURES } from '../../constants/figures.js'
import { Box } from '../../ink/components/box.js'
import { useInput } from '../../ink/hooks/use_input.js'
import { ThemedText } from '../design_system/themed_text.js'

export type TreeSelectNode<T = string> = {
  id: string
  label: string
  value: T
  children?: readonly TreeSelectNode<T>[]
}

export type TreeSelectProps<T = string> = {
  nodes: readonly TreeSelectNode<T>[]
  onSelect: (node: TreeSelectNode<T>) => void
  onCancel?: () => void
  isActive?: boolean
}

type FlatRow<T> = {
  node: TreeSelectNode<T>
  depth: number
  hasChildren: boolean
  expanded: boolean
}

export function TreeSelect<T = string>({
  nodes,
  onSelect,
  onCancel,
  isActive = true,
}: TreeSelectProps<T>): React.ReactNode {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set())
  const [focusedIndex, setFocusedIndex] = useState(0)

  const rows = useMemo(() => {
    const out: FlatRow<T>[] = []
    const walk = (list: readonly TreeSelectNode<T>[], depth: number): void => {
      for (const n of list) {
        const hasChildren = Boolean(n.children && n.children.length > 0)
        const expanded = expandedIds.has(n.id)
        out.push({ node: n, depth, hasChildren, expanded })
        if (hasChildren && expanded && n.children) {
          walk(n.children, depth + 1)
        }
      }
    }
    walk(nodes, 0)
    return out
  }, [nodes, expandedIds])

  const clampedIdx =
    rows.length === 0 ? 0 : Math.min(focusedIndex, rows.length - 1)

  useInput(
    (_input, key) => {
      if (rows.length === 0) return
      const current = rows[clampedIdx]!
      if (key.downArrow) {
        setFocusedIndex(i => (i + 1) % rows.length)
      } else if (key.upArrow) {
        setFocusedIndex(i => (i - 1 + rows.length) % rows.length)
      } else if (key.rightArrow && current.hasChildren && !current.expanded) {
        setExpandedIds(prev => new Set(prev).add(current.node.id))
      } else if (key.leftArrow && current.expanded) {
        setExpandedIds(prev => {
          const next = new Set(prev)
          next.delete(current.node.id)
          return next
        })
      } else if (key.return) {
        onSelect(current.node)
      } else if (key.escape) {
        onCancel?.()
      }
    },
    { isActive },
  )

  return (
    <Box flexDirection="column">
      {rows.map((row, idx) => {
        const isFocused = idx === clampedIdx
        const caret = row.hasChildren
          ? row.expanded
            ? FIGURES.triangleDown
            : FIGURES.triangleRight
          : ' '
        return (
          <Box key={row.node.id} flexDirection="row" paddingLeft={row.depth * 2} gap={1}>
            <ThemedText color={isFocused ? 'suggestion' : 'inactive'}>
              {isFocused ? FIGURES.pointer : ' '}
            </ThemedText>
            <ThemedText dimColor>{caret}</ThemedText>
            <ThemedText color={isFocused ? 'suggestion' : 'text'} bold={isFocused}>
              {row.node.label}
            </ThemedText>
          </Box>
        )
      })}
    </Box>
  )
}
