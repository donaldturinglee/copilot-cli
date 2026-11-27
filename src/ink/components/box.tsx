import React, { forwardRef } from 'react'
import type { DOMElement } from '../dom.js'
import type { EventHandlerMap } from '../events/event_handlers.js'
import type { Styles } from '../styles.js'

export type BoxProps = Styles &
  EventHandlerMap & {
    children?: React.ReactNode
    tabIndex?: number
    autoFocus?: boolean
    'aria-label'?: string
    'aria-role'?: string
  }

export const Box = forwardRef<DOMElement, BoxProps>(function Box(
  {
    children,
    tabIndex,
    autoFocus,
    onClick,
    onClickCapture,
    onMouseDown,
    onMouseDownCapture,
    onMouseUp,
    onMouseUpCapture,
    onWheel,
    onWheelCapture,
    onKeyDown,
    onKeyDownCapture,
    onFocus,
    onBlur,
    onPaste,
    onPasteCapture,
    'aria-label': ariaLabel,
    'aria-role': ariaRole,
    ...styleProps
  },
  ref,
) {
  const style: Styles = {
    flexWrap: 'nowrap',
    flexDirection: 'row',
    flexGrow: 0,
    flexShrink: 1,
    ...styleProps,
  }

  return React.createElement(
    'ink-box',
    {
      ref,
      style,
      tabIndex,
      autoFocus,
      onClick,
      onClickCapture,
      onMouseDown,
      onMouseDownCapture,
      onMouseUp,
      onMouseUpCapture,
      onWheel,
      onWheelCapture,
      onKeyDown,
      onKeyDownCapture,
      onFocus,
      onBlur,
      onPaste,
      onPasteCapture,
      'aria-label': ariaLabel,
      'aria-role': ariaRole,
    },
    children,
  )
})
