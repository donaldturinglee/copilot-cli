import { useContext } from 'react'
import {
  StdinContext,
  type StdinContextValue,
} from '../components/stdin_context.js'

export function useStdin(): StdinContextValue | null {
  return useContext(StdinContext)
}
