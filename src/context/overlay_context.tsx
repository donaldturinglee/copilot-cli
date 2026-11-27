import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

export type OverlayContextValue = {
  activeOverlays: ReadonlySet<string>
  registerOverlay: (id: string) => () => void
  hasAnyOverlay: boolean
}

const OverlayContext = createContext<OverlayContextValue>({
  activeOverlays: new Set(),
  registerOverlay: () => () => {},
  hasAnyOverlay: false,
})

export function OverlayProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [overlays, setOverlays] = useState<ReadonlySet<string>>(
    () => new Set(),
  )

  const registerOverlay = useCallback((id: string) => {
    setOverlays(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    return () => {
      setOverlays(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [])

  const value = useMemo<OverlayContextValue>(
    () => ({
      activeOverlays: overlays,
      registerOverlay,
      hasAnyOverlay: overlays.size > 0,
    }),
    [overlays, registerOverlay],
  )

  return (
    <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>
  )
}

export function useOverlayContext(): OverlayContextValue {
  return useContext(OverlayContext)
}

export function useRegisterOverlay(id: string, active = true): void {
  const { registerOverlay } = useOverlayContext()
  useEffect(() => {
    if (!active) return
    return registerOverlay(id)
  }, [registerOverlay, id, active])
}
