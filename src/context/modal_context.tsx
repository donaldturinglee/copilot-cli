import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type ModalContextValue = {
  activeModalId: string | null
  openModal: (id: string) => void
  closeModal: (id?: string) => void
  isModalOpen: (id?: string) => boolean
}

const ModalContext = createContext<ModalContextValue>({
  activeModalId: null,
  openModal: () => {},
  closeModal: () => {},
  isModalOpen: () => false,
})

export function ModalProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const [activeModalId, setActiveModalId] = useState<string | null>(null)

  const openModal = useCallback((id: string) => {
    setActiveModalId(id)
  }, [])

  const closeModal = useCallback((id?: string) => {
    setActiveModalId(prev => (!id || prev === id ? null : prev))
  }, [])

  const isModalOpen = useCallback(
    (id?: string) => (id ? activeModalId === id : activeModalId !== null),
    [activeModalId],
  )

  const value = useMemo(
    () => ({ activeModalId, openModal, closeModal, isModalOpen }),
    [activeModalId, openModal, closeModal, isModalOpen],
  )

  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>
}

export function useModal(): ModalContextValue {
  return useContext(ModalContext)
}
