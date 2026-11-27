type FocusListener = (focused: boolean) => void

let isFocused = true
const listeners = new Set<FocusListener>()

export function getTerminalFocused(): boolean {
  return isFocused
}

export function setTerminalFocused(focused: boolean): void {
  if (isFocused === focused) return
  isFocused = focused
  for (const listener of listeners) {
    listener(focused)
  }
}

export function subscribeTerminalFocus(listener: FocusListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
