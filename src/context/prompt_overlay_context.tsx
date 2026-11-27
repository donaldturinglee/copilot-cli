import React, { createContext, useContext, useMemo, useState } from 'react'

export type PromptOverlayKind =
  | 'none'
  | 'autocomplete'
  | 'history-search'
  | 'attachments'

export type PromptOverlayContextValue = {
  overlay: PromptOverlayKind
  setOverlay: (kind: PromptOverlayKind) => void
}

const PromptOverlayContext = createContext<PromptOverlayContextValue>({
  overlay: 'none',
  setOverlay: () => {},
})

export function PromptOverlayProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [overlay, setOverlay] = useState<PromptOverlayKind>('none')
  const value = useMemo(() => ({ overlay, setOverlay }), [overlay])
  return (
    <PromptOverlayContext.Provider value={value}>
      {children}
    </PromptOverlayContext.Provider>
  )
}

export function usePromptOverlay(): PromptOverlayContextValue {
  return useContext(PromptOverlayContext)
}
