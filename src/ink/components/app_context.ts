import { createContext } from 'react'

export type AppContextValue = {
  exit: (error?: Error) => void
}

export const AppContext = createContext<AppContextValue>({
  exit: () => {},
})
