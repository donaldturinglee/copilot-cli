import React, { createContext, useContext, useMemo, useState } from 'react'

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'error'

export type VoiceContextValue = {
  enabled: boolean
  state: VoiceState
  setEnabled: (enabled: boolean) => void
  setState: (state: VoiceState) => void
}

const VoiceContext = createContext<VoiceContextValue>({
  enabled: false,
  state: 'idle',
  setEnabled: () => {},
  setState: () => {},
})

export function VoiceProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [enabled, setEnabled] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const value = useMemo(
    () => ({ enabled, state, setEnabled, setState }),
    [enabled, state],
  )
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

export function useVoice(): VoiceContextValue {
  return useContext(VoiceContext)
}
