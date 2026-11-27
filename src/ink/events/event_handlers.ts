import type { ClickEvent } from './click_event.js'
import type { InkEvent } from './event.js'
import type { FocusEvent } from './focus_event.js'
import type { KeyboardEvent } from './keyboard_event.js'
import type { PasteEvent } from './paste_event.js'

export type EventHandler<TEvent extends InkEvent = InkEvent> = (
  event: TEvent,
) => void

export type EventHandlerMap = {
  onClick?: EventHandler<ClickEvent>
  onClickCapture?: EventHandler<ClickEvent>
  onMouseDown?: EventHandler<ClickEvent>
  onMouseDownCapture?: EventHandler<ClickEvent>
  onMouseUp?: EventHandler<ClickEvent>
  onMouseUpCapture?: EventHandler<ClickEvent>
  onWheel?: EventHandler<ClickEvent>
  onWheelCapture?: EventHandler<ClickEvent>
  onKeyDown?: EventHandler<KeyboardEvent>
  onKeyDownCapture?: EventHandler<KeyboardEvent>
  onFocus?: EventHandler<FocusEvent>
  onBlur?: EventHandler<FocusEvent>
  onPaste?: EventHandler<PasteEvent>
  onPasteCapture?: EventHandler<PasteEvent>
}

const EVENT_TYPE_TO_PROP: Record<
  string,
  { bubble: keyof EventHandlerMap; capture?: keyof EventHandlerMap }
> = {
  click: { bubble: 'onClick', capture: 'onClickCapture' },
  mousedown: { bubble: 'onMouseDown', capture: 'onMouseDownCapture' },
  mouseup: { bubble: 'onMouseUp', capture: 'onMouseUpCapture' },
  wheel: { bubble: 'onWheel', capture: 'onWheelCapture' },
  keydown: { bubble: 'onKeyDown', capture: 'onKeyDownCapture' },
  focus: { bubble: 'onFocus' },
  blur: { bubble: 'onBlur' },
  paste: { bubble: 'onPaste', capture: 'onPasteCapture' },
}

export function getHandlerPropNames(eventType: string): {
  bubble: keyof EventHandlerMap
  capture?: keyof EventHandlerMap
} | undefined {
  return EVENT_TYPE_TO_PROP[eventType]
}
