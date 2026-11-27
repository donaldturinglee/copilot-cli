import { useContext } from 'react'
import { AppContext, type AppContextValue } from '../components/app_context.js'

export function useApp(): AppContextValue {
  return useContext(AppContext)
}
