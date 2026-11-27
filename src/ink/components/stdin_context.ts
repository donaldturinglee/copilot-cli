import { createContext } from 'react'
import type { Readable } from 'stream'
import type { TypedEventEmitter } from '../events/emitter.js'
import type { InputEvent } from '../events/input_event.js'
import type { PasteEvent } from '../events/paste_event.js'
import type { ParsedMouse } from '../parse_keypress.js'

export type InternalInputEvents = {
  input: InputEvent
  paste: PasteEvent
  mouse: ParsedMouse
}

export type StdinContextValue = {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  setRawMode: (value: boolean) => void
  isRawModeSupported: boolean
  internal_exitOnCtrlC: boolean
  internal_eventEmitter: TypedEventEmitter<InternalInputEvents>
}

export const StdinContext = createContext<StdinContextValue | null>(null)
