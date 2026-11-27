import React from 'react'
import { Box } from '../../ink/components/box.js'
import { OrderedListItem, type OrderedListItemProps } from './ordered_list_item.js'

export type OrderedListProps = {
  start?: number
  children: React.ReactNode
}

export function OrderedList({
  start = 1,
  children,
}: OrderedListProps): React.ReactNode {
  const items = React.Children.toArray(children)
  return (
    <Box flexDirection="column">
      {items.map((child, idx) => {
        if (React.isValidElement<OrderedListItemProps>(child)) {
          return React.cloneElement(child, {
            key: child.key ?? idx,
            marker: child.props.marker ?? `${start + idx}.`,
          })
        }
        return (
          <OrderedListItem key={idx} marker={`${start + idx}.`}>
            {child}
          </OrderedListItem>
        )
      })}
    </Box>
  )
}
