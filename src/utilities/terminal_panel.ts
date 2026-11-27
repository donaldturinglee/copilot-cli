export type TerminalPanelState = {
  visible: boolean
  height: number
  title: string
}

let panelState: TerminalPanelState = {
  visible: false,
  height: 12,
  title: 'Terminal',
}

const subscribers = new Set<(state: TerminalPanelState) => void>()

export function getTerminalPanelState(): TerminalPanelState {
  return panelState
}

export function setTerminalPanelVisible(visible: boolean): void {
  if (panelState.visible === visible) return
  panelState = { ...panelState, visible }
  for (const fn of subscribers) fn(panelState)
}

export function toggleTerminalPanel(): boolean {
  setTerminalPanelVisible(!panelState.visible)
  return panelState.visible
}

export function setTerminalPanelHeight(height: number): void {
  const clamped = Math.max(4, Math.min(40, Math.floor(height)))
  if (panelState.height === clamped) return
  panelState = { ...panelState, height: clamped }
  for (const fn of subscribers) fn(panelState)
}

export function subscribeTerminalPanel(
  fn: (state: TerminalPanelState) => void,
): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}
